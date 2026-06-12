const MESSAGE = {
  GET_STATE: "WECHAT_ARTICLE_TTS_GET_STATE",
  START: "WECHAT_ARTICLE_TTS_START",
  START_PREPARED: "WECHAT_ARTICLE_TTS_START_PREPARED",
  PREPARE_ARTICLE: "WECHAT_ARTICLE_TTS_PREPARE_ARTICLE",
  STOP: "WECHAT_ARTICLE_TTS_STOP",
  TOGGLE_PAUSE: "WECHAT_ARTICLE_TTS_TOGGLE_PAUSE",
  NEXT: "WECHAT_ARTICLE_TTS_NEXT",
  PREVIOUS: "WECHAT_ARTICLE_TTS_PREVIOUS",
  SEEK: "WECHAT_ARTICLE_TTS_SEEK",
  SET_RATE: "WECHAT_ARTICLE_TTS_SET_RATE",
  PING: "WECHAT_ARTICLE_TTS_PING",
  PREPARE: "WECHAT_ARTICLE_TTS_PREPARE",
  HIGHLIGHT: "WECHAT_ARTICLE_TTS_HIGHLIGHT",
  CLEAR: "WECHAT_ARTICLE_TTS_CLEAR",
  PLAYER_STATE: "WECHAT_ARTICLE_TTS_PLAYER_STATE"
};

const CONTENT_SCRIPT_VERSION = "2026-06-09.content-focus-v6";
const CONTENT_MESSAGE = {
  PING: "WECHAT_ARTICLE_TTS_CONTENT_PING",
  PREPARE: "WECHAT_ARTICLE_TTS_CONTENT_PREPARE",
  HIGHLIGHT: "WECHAT_ARTICLE_TTS_CONTENT_HIGHLIGHT",
  CLEAR: "WECHAT_ARTICLE_TTS_CONTENT_CLEAR",
  PLAYER_STATE: "WECHAT_ARTICLE_TTS_CONTENT_PLAYER_STATE"
};

const DEFAULT_RATE = 1.25;
const MIN_RATE = 0.75;
const MAX_RATE = 2;
const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2];
const PROGRESS_STORAGE_PREFIX = "wechat-article-tts:article-progress:";
const RATE_STORAGE_KEY = "wechat-article-tts:rate";
const DEFAULT_ZH_LANG = "zh-CN";
const TTS_START_TIMEOUT_MS = 1500;
const TTS_STOP_SETTLE_MS = 80;
const TTS_START_RETRY_LIMIT = 1;
const TTS_START_EVENTS = new Set(["start", "word", "sentence", "marker"]);
const TTS_FINAL_EVENTS = new Set(["end", "error", "interrupted", "cancelled"]);

let settings = { rate: DEFAULT_RATE };
let session = null;
let speechToken = 0;
let ttsStartWaiter = null;

const storageReady = chrome.storage.local
  .get({ [RATE_STORAGE_KEY]: DEFAULT_RATE })
  .then((stored) => {
    settings.rate = normalizeRate(stored[RATE_STORAGE_KEY]);
  })
  .catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "操作失败"
      });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!session || session.tabId !== tabId) {
    return;
  }

  void handleRemovedSessionTab(tabId);
});

async function handleMessage(message, sender) {
  await storageReady;

  const senderTabId = sender?.tab?.id;

  switch (message.type) {
    case MESSAGE.GET_STATE:
      return getState(message.tabId ?? senderTabId);
    case MESSAGE.START:
      return startReading(message.tabId ?? senderTabId, message.rate, message.takeover === true);
    case MESSAGE.PREPARE_ARTICLE:
      return prepareArticleForPopup(message.tabId ?? senderTabId);
    case MESSAGE.START_PREPARED:
      return startSentenceListReading(
        message.tabId ?? senderTabId,
        message.sentences,
        message.title || "公众号文章",
        message.rate,
        message.startIndex,
        message.articleKey,
        message.takeover === true,
        message.explicitStartIndex === true
      );
    case MESSAGE.STOP:
      return stopReading({ requesterTabId: message.tabId ?? senderTabId });
    case MESSAGE.TOGGLE_PAUSE:
      return togglePause(message.tabId ?? senderTabId);
    case MESSAGE.NEXT:
      return jumpBy(1, message.tabId ?? senderTabId);
    case MESSAGE.PREVIOUS:
      return jumpBy(-1, message.tabId ?? senderTabId);
    case MESSAGE.SEEK:
      return seekTo(message.index, message.tabId ?? senderTabId);
    case MESSAGE.SET_RATE:
      return setRate(message.rate, message.tabId ?? senderTabId);
    default:
      return { ok: false, error: "未知操作" };
  }
}

async function startReading(tabId, requestedRate, takeover = false) {
  assertTabId(tabId);

  if (hasBlockingForeignSession(tabId) && !takeover) {
    return getState(tabId);
  }

  const rate = normalizeRate(requestedRate ?? settings.rate);
  settings.rate = rate;
  await chrome.storage.local.set({ [RATE_STORAGE_KEY]: rate });

  await ensureContentScript(tabId);

  const prepared = await sendContentMessage(tabId, CONTENT_MESSAGE.PREPARE);
  if (!prepared?.ok) {
    throw new Error(prepared?.error || "没有找到可朗读的公众号正文");
  }

  if (!Array.isArray(prepared.sentences) || prepared.sentences.length === 0) {
    throw new Error("没有识别到可朗读的句子");
  }

  return startPreparedReading(tabId, prepared.sentences, prepared.title, rate, 0, prepared.articleKey, takeover);
}

async function prepareArticleForPopup(tabId) {
  assertTabId(tabId);

  await ensureContentScript(tabId);

  const prepared = await sendContentMessage(tabId, CONTENT_MESSAGE.PREPARE);
  if (!prepared?.ok) {
    throw new Error(prepared?.error || "没有找到可朗读的公众号正文");
  }

  const sentences = normalizeSentences(prepared.sentences);
  if (sentences.length === 0) {
    throw new Error("没有识别到可朗读的句子");
  }

  const articleKey = String(prepared.articleKey || "");
  const title = prepared.title || "公众号文章";
  const startIndex = await getStoredProgressIndex(articleKey, sentences.length, title);

  return {
    ok: true,
    status: "ready",
    rate: settings.rate,
    index: startIndex + 1,
    total: sentences.length,
    title,
    source: "article",
    articleKey,
    sentences,
    currentId: null,
    sentenceText: "准备播放",
    error: ""
  };
}

async function startSentenceListReading(
  tabId,
  sentences,
  title,
  requestedRate,
  startIndex = 0,
  articleKey = "",
  takeover = false,
  explicitStartIndex = false
) {
  assertTabId(tabId);

  if (hasBlockingForeignSession(tabId) && !takeover) {
    return getState(tabId);
  }

  const rate = normalizeRate(requestedRate ?? settings.rate);
  settings.rate = rate;
  await chrome.storage.local.set({ [RATE_STORAGE_KEY]: rate });

  return startPreparedReading(
    tabId,
    sentences,
    title || "公众号文章",
    rate,
    startIndex,
    articleKey,
    takeover,
    explicitStartIndex
  );
}

async function startPreparedReading(
  tabId,
  sentences,
  title,
  rate,
  startIndex = 0,
  articleKey = "",
  takeover = false,
  explicitStartIndex = false
) {
  const cleanSentences = normalizeSentences(sentences);
  if (cleanSentences.length === 0) {
    throw new Error("没有识别到可朗读的句子");
  }

  if (hasBlockingForeignSession(tabId) && !takeover) {
    return getState(tabId);
  }

  const normalizedArticleKey = String(articleKey || "");
  const resolvedStartIndex = !explicitStartIndex
    ? await getStoredProgressIndex(normalizedArticleKey, cleanSentences.length, title)
    : Math.round(Number(startIndex) || 0);
  const normalizedStartIndex = clamp(resolvedStartIndex, 0, cleanSentences.length - 1);
  const previousTabId = session && session.tabId !== tabId ? session.tabId : null;

  await stopReading({ keepSettings: true, preserveHighlight: Boolean(previousTabId) });

  session = {
    tabId,
    sentences: cleanSentences,
    index: normalizedStartIndex,
    rate,
    status: "starting",
    needsRestart: false,
    title: title || "",
    source: "article",
    articleKey: normalizedArticleKey,
    error: ""
  };

  await speakCurrentSentence();
  if (previousTabId) {
    await sendPlayerState(previousTabId);
  }

  return getState(tabId);
}

async function stopReading(options = {}) {
  if (!session) {
    return getState(options.requesterTabId);
  }

  if (hasForeignSession(options.requesterTabId)) {
    return getState(options.requesterTabId);
  }

  const tabId = session?.tabId;
  if (session?.status !== "completed") {
    await saveSessionProgress().catch(() => {});
  }

  speechToken += 1;
  disposeTtsStartWaiter();
  chrome.tts.stop();

  if (tabId && !options.preserveHighlight) {
    await sendContentMessage(tabId, CONTENT_MESSAGE.CLEAR).catch(() => {});
  }

  session = null;
  if (!options.keepSettings) {
    await storageReady;
  }

  if (tabId) {
    await sendPlayerState(tabId);
  }

  return getState();
}

async function handleRemovedSessionTab(tabId) {
  if (!session || session.tabId !== tabId) {
    return;
  }

  const progressSnapshot = createSessionProgressSnapshot(session);
  const saveProgress = progressSnapshot
    ? saveProgressSnapshot(progressSnapshot).catch(() => {})
    : Promise.resolve();

  speechToken += 1;
  disposeTtsStartWaiter();
  chrome.tts.stop();
  session = null;

  await saveProgress;
}

async function togglePause(tabId) {
  const unavailableState = getControlUnavailableState(tabId);
  if (unavailableState) {
    return unavailableState;
  }

  if (session.status === "playing") {
    chrome.tts.pause();
    session.status = "paused";
    await saveSessionProgress().catch(() => {});
  } else if (session.status === "paused") {
    if (session.needsRestart) {
      await speakCurrentSentence();
    } else {
      chrome.tts.resume();
      session.status = "playing";
      await sendPlayerState(session.tabId);
    }
  }

  if (session?.status === "paused") {
    await sendPlayerState(session.tabId);
  }

  return getState(tabId ?? session.tabId);
}

async function jumpBy(delta, tabId) {
  const unavailableState = getControlUnavailableState(tabId);
  if (unavailableState) {
    return unavailableState;
  }

  const nextIndex = clamp(session.index + delta, 0, session.sentences.length - 1);
  if (nextIndex === session.index && session.status !== "paused") {
    return getState(tabId ?? session.tabId);
  }

  session.index = nextIndex;
  session.status = "playing";
  session.needsRestart = false;
  speechToken += 1;
  chrome.tts.stop();
  await speakCurrentSentence();
  return getState(tabId ?? session.tabId);
}

async function seekTo(indexValue, tabId) {
  const unavailableState = getControlUnavailableState(tabId);
  if (unavailableState) {
    return unavailableState;
  }

  const numericIndex = Number(indexValue);
  const requestedIndex = Number.isFinite(numericIndex) ? numericIndex : 1;
  const targetIndex = clamp(Math.round(requestedIndex) - 1, 0, session.sentences.length - 1);
  const shouldRemainPaused = session.status === "paused";

  session.index = targetIndex;
  speechToken += 1;
  chrome.tts.stop();

  if (shouldRemainPaused) {
    const sentence = session.sentences[session.index];
    session.status = "paused";
    session.needsRestart = true;
    session.error = "";
    await sendContentMessage(session.tabId, CONTENT_MESSAGE.HIGHLIGHT, {
      id: sentence.id,
      index: session.index,
      total: session.sentences.length
    }).catch(() => {});
    await saveSessionProgress().catch(() => {});
    await sendPlayerState(session.tabId);
    return getState(tabId ?? session.tabId);
  }

  session.status = "starting";
  session.needsRestart = false;
  await speakCurrentSentence();
  return getState(tabId ?? session.tabId);
}

async function setRate(rateValue, tabId) {
  const rate = normalizeRate(rateValue);
  settings.rate = rate;
  await chrome.storage.local.set({ [RATE_STORAGE_KEY]: rate });

  if (session && !hasForeignSession(tabId)) {
    session.rate = rate;
    await sendPlayerState(session.tabId);
  }

  return getState(tabId ?? session?.tabId);
}

async function speakCurrentSentence(retryCount = 0) {
  if (!session) {
    return;
  }

  if (session.index >= session.sentences.length) {
    await markCompleted();
    return;
  }

  const sentence = session.sentences[session.index];
  const utterance = buildSpeechText(sentence.text);
  const token = (speechToken += 1);

  session.status = "starting";
  session.needsRestart = false;
  session.error = "";

  const highlighted = await highlightCurrentSentenceWithRepair();
  if (!highlighted) {
    if (session && token === speechToken) {
      session.status = "error";
      session.needsRestart = true;
      session.error = "页面状态已失效，请刷新公众号文章后再试";
      await sendPlayerState(session.tabId);
    }
    return;
  }

  await saveSessionProgress().catch(() => {});
  await sendPlayerState(session.tabId);

  const startWaiter = createTtsStartWaiter(token);
  try {
    await chrome.tts.speak(utterance, {
      lang: DEFAULT_ZH_LANG,
      rate: session.rate,
      pitch: 1,
      volume: 1,
      enqueue: false,
      onEvent: (event) => handleTtsEvent(token, event)
    });
  } catch (error) {
    resolveTtsStartWaiter(token, { started: false, error });
    if (session && token === speechToken) {
      session.status = "error";
      session.needsRestart = true;
      session.error = error?.message || "朗读失败";
      await sendPlayerState(session.tabId);
    }
    return;
  }

  const startResult = await waitForTtsStart(token, startWaiter);
  if (!session || token !== speechToken) {
    return;
  }

  if (startResult.finalEvent) {
    return;
  }

  if (startResult.started) {
    session.status = "playing";
    session.needsRestart = false;
    session.error = "";
    await sendPlayerState(session.tabId);
    return;
  }

  if (retryCount < TTS_START_RETRY_LIMIT) {
    await resetTtsBeforeRetry(token);
    if (session) {
      await speakCurrentSentence(retryCount + 1);
    }
    return;
  }

  session.status = "error";
  session.needsRestart = true;
  session.error = "朗读启动失败，请稍后重试";
  await sendPlayerState(session.tabId);
}

async function highlightCurrentSentenceWithRepair() {
  if (!session) {
    return false;
  }

  let response = await sendCurrentHighlight().catch(() => null);
  if (response?.ok) {
    return true;
  }

  const repaired = await repairPreparedArticleForSession().catch(() => false);
  if (!repaired) {
    return false;
  }

  response = await sendCurrentHighlight().catch(() => null);
  return response?.ok === true;
}

function sendCurrentHighlight() {
  const sentence = session?.sentences?.[session.index];
  if (!session || !sentence) {
    return Promise.resolve({ ok: false });
  }

  return sendContentMessage(session.tabId, CONTENT_MESSAGE.HIGHLIGHT, {
    id: sentence.id,
    index: session.index,
    total: session.sentences.length
  });
}

async function repairPreparedArticleForSession() {
  if (!session) {
    return false;
  }

  await ensureContentScript(session.tabId);
  const prepared = await sendContentMessage(session.tabId, CONTENT_MESSAGE.PREPARE);
  if (!prepared?.ok) {
    return false;
  }

  const cleanSentences = normalizeSentences(prepared.sentences);
  if (cleanSentences.length === 0) {
    return false;
  }

  const preparedArticleKey = String(prepared.articleKey || "");
  if (session.articleKey && preparedArticleKey && session.articleKey !== preparedArticleKey) {
    return false;
  }

  session.sentences = cleanSentences;
  session.index = clamp(session.index, 0, cleanSentences.length - 1);
  session.title = prepared.title || session.title;
  session.articleKey = preparedArticleKey || session.articleKey;
  return true;
}

function createTtsStartWaiter(token) {
  disposeTtsStartWaiter();

  const waiter = {
    token,
    done: false,
    resolve: null,
    promise: null
  };
  waiter.promise = new Promise((resolve) => {
    waiter.resolve = (result) => {
      if (waiter.done) {
        return;
      }

      waiter.done = true;
      if (ttsStartWaiter === waiter) {
        ttsStartWaiter = null;
      }
      resolve(result);
    };
  });

  ttsStartWaiter = waiter;
  return waiter;
}

function disposeTtsStartWaiter(waiter = ttsStartWaiter) {
  if (!waiter) {
    return;
  }

  waiter.done = true;
  if (ttsStartWaiter === waiter) {
    ttsStartWaiter = null;
  }
}

function resolveTtsStartWaiter(token, result) {
  if (!ttsStartWaiter || ttsStartWaiter.token !== token || ttsStartWaiter.done) {
    return;
  }

  ttsStartWaiter.resolve(result);
}

async function waitForTtsStart(token, waiter) {
  const result = await Promise.race([
    waiter.promise,
    delay(TTS_START_TIMEOUT_MS).then(() => ({ timedOut: true }))
  ]);

  if (!result?.timedOut) {
    return result;
  }

  disposeTtsStartWaiter(waiter);
  if (!session || token !== speechToken) {
    return { started: false, stale: true };
  }

  const speaking = await chrome.tts.isSpeaking().catch(() => false);
  return {
    started: Boolean(speaking),
    timedOut: true
  };
}

async function resetTtsBeforeRetry(token) {
  if (token === speechToken) {
    speechToken += 1;
  }
  disposeTtsStartWaiter();
  chrome.tts.stop();
  await delay(TTS_STOP_SETTLE_MS);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handleTtsEvent(token, event) {
  if (!session || token !== speechToken) {
    return;
  }

  if (TTS_START_EVENTS.has(event.type)) {
    resolveTtsStartWaiter(token, { started: true, event });
    return;
  }

  if (TTS_FINAL_EVENTS.has(event.type)) {
    resolveTtsStartWaiter(token, { started: false, finalEvent: event });
    void handleTtsFinalEvent(token, event);
  }
}

async function handleTtsFinalEvent(token, event) {
  if (!session || token !== speechToken) {
    return;
  }

  if (event.type === "end") {
    session.index += 1;
    if (session.index >= session.sentences.length) {
      await markCompleted();
      return;
    }

    await speakCurrentSentence();
    return;
  }

  if (event.type === "error") {
    session.status = "error";
    session.needsRestart = true;
    session.error = event.errorMessage || "朗读失败";
    await sendPlayerState(session.tabId);
    return;
  }

  if (event.type === "interrupted" || event.type === "cancelled") {
    session.status = "paused";
    session.needsRestart = true;
    session.error = "";
    await saveSessionProgress().catch(() => {});
    await sendPlayerState(session.tabId);
  }
}

async function markCompleted() {
  if (!session) {
    return;
  }

  session.status = "completed";
  await clearSessionProgress().catch(() => {});
  await sendContentMessage(session.tabId, CONTENT_MESSAGE.CLEAR).catch(() => {});
  await sendPlayerState(session.tabId);
}

async function ensureContentScript(tabId) {
  try {
    const response = await sendContentMessage(tabId, CONTENT_MESSAGE.PING);
    if (response?.ok && response.version === CONTENT_SCRIPT_VERSION) {
      return;
    }
  } catch (_) {
    // Existing pages opened before installing the extension need explicit injection.
  }

  try {
    const legacyResponse = await sendToTab(tabId, { type: MESSAGE.PING });
    if (legacyResponse?.ok && legacyResponse.version === CONTENT_SCRIPT_VERSION) {
      return;
    }
  } catch (_) {
    // Existing pages opened before installing the extension need explicit injection.
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["contentStyle.css"]
    });
  } catch (_) {
    // CSS may already be present from the static content script.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["contentScript.js"]
    });
  } catch (error) {
    throw new Error("请在微信公众号文章页面使用，或刷新页面后再试");
  }

  try {
    const response = await sendContentMessage(tabId, CONTENT_MESSAGE.PING);
    if (response?.ok && response.version === CONTENT_SCRIPT_VERSION) {
      return;
    }
  } catch (_) {
    // Fall through to the user-facing error below.
  }

  throw new Error("页面脚本版本未更新，请刷新公众号文章后再试");
}

function sendContentMessage(tabId, type, payload = {}) {
  return sendToTab(tabId, {
    ...payload,
    type,
    targetVersion: CONTENT_SCRIPT_VERSION
  });
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

const SPEECH_ALIAS_ENTRIES = [
  ["CEO", "首席执行官"],
  ["CTO", "首席技术官"],
  ["CFO", "首席财务官"],
  ["COO", "首席运营官"],
  ["CMO", "首席营销官"],
  ["CIO", "首席信息官"],
  ["CPO", "首席产品官"],
  ["CHRO", "首席人力资源官"],
  ["CXO", "企业高管"],
  ["AI", "人工智能"],
  ["AGI", "通用人工智能"],
  ["AIGC", "人工智能生成内容"],
  ["LLM", "大语言模型"],
  ["GPU", "图形处理器"],
  ["CPU", "中央处理器"],
  ["API", "接口"],
  ["APP", "应用"],
  ["VC", "风险投资"],
  ["PE", "私募股权"],
  ["IPO", "首次公开募股"],
  ["ROI", "投资回报率"],
  ["KPI", "关键绩效指标"],
  ["SOP", "标准作业流程"],
  ["B2B", "企业对企业"],
  ["B2C", "企业对消费者"],
  ["ToB", "B 端"],
  ["ToC", "C 端"],
  ["SaaS", "萨斯"],
  ["PaaS", "平台即服务"],
  ["IaaS", "基础设施即服务"],
  ["UI", "用户界面"],
  ["UX", "用户体验"],
  ["VR", "虚拟现实"],
  ["AR", "增强现实"],
  ["MR", "混合现实"],
  ["XR", "扩展现实"],
  ["OpenAI", "Open A I"],
  ["ChatGPT", "Chat G P T"],
  ["GPT", "G P T"],
  ["GPT-3", "G P T 三"],
  ["GPT-4", "G P T 四"],
  ["GPT-4o", "G P T 四 O"],
  ["GPT-5", "G P T 五"],
  ["Web3", "Web 三"],
  ["Agent", "智能体"],
  ["Agents", "智能体"],
  ["Prompt", "提示词"],
  ["Token", "词元"],
  ["Tokens", "词元"]
];

const SPEECH_ALIASES = new Map(
  SPEECH_ALIAS_ENTRIES.map(([term, replacement]) => [term.toLowerCase(), replacement])
);
const ENGLISH_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*(?:[._+#/'-][A-Za-z0-9]+)*|[0-9]+[A-Za-z][A-Za-z0-9]*(?:[._+#/'-][A-Za-z0-9]+)*/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'“”‘’]+/gi;
const URL_TRAILING_PUNCTUATION_RE = /[.,!?;:，。！？；：、…)\]）】》}]+$/;
const URL_SPEECH_PLACEHOLDER = "\uE000\uE001";
const URL_SPEECH_LABEL = "【URL】";
const DIGIT_SPEECH = {
  0: "零",
  1: "一",
  2: "二",
  3: "三",
  4: "四",
  5: "五",
  6: "六",
  7: "七",
  8: "八",
  9: "九"
};

function getState(tabId) {
  if (hasForeignSession(tabId)) {
    if (isBlockingSession(session)) {
      return getBusyState();
    }

    return getIdleState();
  }

  if (!session) {
    return getIdleState();
  }

  const currentSentence = session.sentences[session.index] || session.sentences[session.sentences.length - 1];

  return {
    ok: true,
    status: session.status,
    rate: session.rate,
    index: Math.min(session.index + 1, session.sentences.length),
    total: session.sentences.length,
    title: session.title,
    source: session.source || "",
    articleKey: session.articleKey || "",
    currentId: Number.isInteger(currentSentence?.id) ? currentSentence.id : null,
    sentenceText: currentSentence?.text || "",
    error: session.error
  };
}

function getIdleState() {
  return {
    ok: true,
    status: "idle",
    rate: settings.rate,
    index: 0,
    total: 0,
    title: "",
    source: "",
    articleKey: "",
    currentId: null,
    sentenceText: "",
    error: ""
  };
}

function getBusyState() {
  return {
    ...getIdleState(),
    status: "busy",
    activeTabId: session.tabId,
    activeTitle: session.title || "另一标签页",
    activeStatus: session.status || ""
  };
}

function getControlUnavailableState(tabId) {
  if (!session || hasForeignSession(tabId)) {
    return getState(tabId);
  }

  return null;
}

function hasForeignSession(tabId) {
  return Boolean(session && Number.isInteger(tabId) && session.tabId !== tabId);
}

function hasBlockingForeignSession(tabId) {
  return hasForeignSession(tabId) && isBlockingSession(session);
}

function isBlockingSession(sourceSession) {
  return Boolean(sourceSession && !["completed", "error"].includes(sourceSession.status));
}

async function saveSessionProgress() {
  const progressSnapshot = createSessionProgressSnapshot(session);
  if (!progressSnapshot) {
    return;
  }

  await saveProgressSnapshot(progressSnapshot);
}

function createSessionProgressSnapshot(sourceSession) {
  const total = sourceSession?.sentences?.length || 0;
  if (
    !sourceSession ||
    sourceSession.status === "completed" ||
    sourceSession.source !== "article" ||
    !sourceSession.articleKey ||
    total <= 0
  ) {
    return null;
  }

  return {
    articleKey: sourceSession.articleKey,
    index: clamp(sourceSession.index, 0, total - 1),
    total,
    title: sourceSession.title || ""
  };
}

async function saveProgressSnapshot(progressSnapshot) {
  if (!progressSnapshot?.articleKey || progressSnapshot.total <= 0) {
    return;
  }

  const total = Math.max(0, Math.round(Number(progressSnapshot.total) || 0));
  if (total <= 0) {
    return;
  }

  const index = clamp(Math.round(Number(progressSnapshot.index) || 0), 0, total - 1);
  await chrome.storage.local.set({
    [getProgressStorageKey(progressSnapshot.articleKey)]: {
      articleKey: progressSnapshot.articleKey,
      index,
      total,
      title: progressSnapshot.title || "",
      updatedAt: Date.now()
    }
  });
}

async function clearSessionProgress() {
  if (!session?.articleKey) {
    return;
  }

  await chrome.storage.local.remove(getProgressStorageKey(session.articleKey));
}

async function getStoredProgressIndex(articleKey, total, title = "") {
  if (!articleKey || total <= 0) {
    return 0;
  }

  const stored = await chrome.storage.local.get(getProgressStorageKey(articleKey)).catch(() => ({}));
  const progress = stored[getProgressStorageKey(articleKey)];
  if (!isStoredProgressForArticle(progress, articleKey, total, title)) {
    return 0;
  }

  const index = Math.round(Number(progress.index) || 0);
  return clamp(index, 0, total - 1);
}

function isStoredProgressForArticle(progress, articleKey, total, title) {
  if (!progress || progress.articleKey !== articleKey) {
    return false;
  }

  const storedTotal = Number(progress.total);
  if (Number.isFinite(storedTotal) && Math.round(storedTotal) !== Math.round(Number(total) || 0)) {
    return false;
  }

  const storedTitle = normalizeProgressTitle(progress.title);
  const currentTitle = normalizeProgressTitle(title);
  if (storedTitle && currentTitle && storedTitle !== currentTitle) {
    return false;
  }

  return true;
}

function normalizeProgressTitle(title) {
  return String(title || "").replace(/\s+/g, " ").trim();
}

function getProgressStorageKey(articleKey) {
  return `${PROGRESS_STORAGE_PREFIX}${articleKey}`;
}

async function sendPlayerState(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  await sendContentMessage(tabId, CONTENT_MESSAGE.PLAYER_STATE, {
    state: getState(tabId)
  }).catch(() => {});
}

function buildSpeechText(text) {
  return replaceUrlsWithPlaceholder(text)
    .replace(ENGLISH_TOKEN_RE, (token) => {
      return getSpeechAlias(token) || getFallbackPronunciation(token);
    })
    .replaceAll(URL_SPEECH_PLACEHOLDER, URL_SPEECH_LABEL);
}

function replaceUrlsWithPlaceholder(text) {
  return String(text || "").replace(URL_RE, (match) => {
    const trailing = match.match(URL_TRAILING_PUNCTUATION_RE)?.[0] || "";
    const urlText = trailing ? match.slice(0, -trailing.length) : match;

    if (!urlText) {
      return match;
    }

    return `${URL_SPEECH_PLACEHOLDER}${trailing}`;
  });
}

function getSpeechAlias(token) {
  return SPEECH_ALIASES.get(String(token || "").toLowerCase()) || "";
}

function getFallbackPronunciation(token) {
  const value = String(token || "");
  if (isAcronymLike(value)) {
    return spellToken(value);
  }

  const gptVersion = value.match(/^GPT-?(\d+)([A-Za-z])?$/i);
  if (gptVersion) {
    const suffix = gptVersion[2] ? ` ${gptVersion[2].toUpperCase()}` : "";
    return `G P T ${spellDigits(gptVersion[1])}${suffix}`;
  }

  return value;
}

function isAcronymLike(token) {
  return (
    /^[A-Z0-9][A-Z0-9._+#/'-]{1,}$/.test(token) &&
    /[A-Z]{2,}/.test(token)
  );
}

function spellToken(token) {
  return Array.from(token)
    .map((char) => {
      if (/[A-Za-z]/.test(char)) {
        return char.toUpperCase();
      }

      if (/[0-9]/.test(char)) {
        return DIGIT_SPEECH[char] || char;
      }

      return " ";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function spellDigits(value) {
  return Array.from(String(value || ""))
    .map((digit) => DIGIT_SPEECH[digit] || digit)
    .join(" ");
}

function assertTabId(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("没有找到当前标签页");
  }
}

function normalizeRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_RATE;
  }
  const clamped = clamp(numeric, MIN_RATE, MAX_RATE);
  return RATE_OPTIONS.reduce((closest, option) => {
    return Math.abs(option - clamped) < Math.abs(closest - clamped) ? option : closest;
  }, DEFAULT_RATE);
}

function normalizeSentences(sentences) {
  if (!Array.isArray(sentences)) {
    return [];
  }

  return sentences
    .map((sentence, index) => ({
      id: Number.isInteger(sentence?.id) ? sentence.id : index,
      text: String(sentence?.text || "").replace(/\s+/g, " ").trim()
    }))
    .filter((sentence) => sentence.text.length > 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
