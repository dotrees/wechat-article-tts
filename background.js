const MESSAGE = {
  GET_STATE: "WECHAT_ARTICLE_TTS_GET_STATE",
  START: "WECHAT_ARTICLE_TTS_START",
  START_SENTENCES: "WECHAT_ARTICLE_TTS_START_SENTENCES",
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

const DEFAULT_RATE = 1.25;
const MIN_RATE = 0.75;
const MAX_RATE = 1.5;
const RATE_OPTIONS = [0.75, 1, 1.25, 1.5];
const PROGRESS_STORAGE_PREFIX = "wechat-article-tts:article-progress:";
const RATE_STORAGE_KEY = "wechat-article-tts:rate";
const DEFAULT_ZH_LANG = "zh-CN";

let settings = { rate: DEFAULT_RATE };
let session = null;
let speechToken = 0;

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
      return startReading(message.tabId, message.rate);
    case MESSAGE.PREPARE_ARTICLE:
      return prepareArticleForPopup(message.tabId ?? senderTabId);
    case MESSAGE.START_SENTENCES:
      return startSentenceListReading(
        message.tabId ?? senderTabId,
        message.sentences,
        message.title,
        message.rate,
        "selection",
        message.startIndex,
        ""
      );
    case MESSAGE.START_PREPARED:
      return startSentenceListReading(
        message.tabId ?? senderTabId,
        message.sentences,
        message.title || "公众号文章",
        message.rate,
        "article",
        message.startIndex,
        message.articleKey
      );
    case MESSAGE.STOP:
      return stopReading();
    case MESSAGE.TOGGLE_PAUSE:
      return togglePause();
    case MESSAGE.NEXT:
      return jumpBy(1);
    case MESSAGE.PREVIOUS:
      return jumpBy(-1);
    case MESSAGE.SEEK:
      return seekTo(message.index);
    case MESSAGE.SET_RATE:
      return setRate(message.rate);
    default:
      return { ok: false, error: "未知操作" };
  }
}

async function startReading(tabId, requestedRate) {
  assertTabId(tabId);

  const rate = normalizeRate(requestedRate ?? settings.rate);
  settings.rate = rate;
  await chrome.storage.local.set({ [RATE_STORAGE_KEY]: rate });

  await stopReading({ keepSettings: true });
  await ensureContentScript(tabId);

  const prepared = await sendToTab(tabId, { type: MESSAGE.PREPARE });
  if (!prepared?.ok) {
    throw new Error(prepared?.error || "没有找到可朗读的公众号正文");
  }

  if (!Array.isArray(prepared.sentences) || prepared.sentences.length === 0) {
    throw new Error("没有识别到可朗读的句子");
  }

  const resumeIndex = await getStoredProgressIndex(prepared.articleKey, prepared.sentences.length);
  return startPreparedReading(tabId, prepared.sentences, prepared.title, rate, "article", resumeIndex, prepared.articleKey);
}

async function prepareArticleForPopup(tabId) {
  assertTabId(tabId);

  await ensureContentScript(tabId);

  const prepared = await sendToTab(tabId, { type: MESSAGE.PREPARE });
  if (!prepared?.ok) {
    throw new Error(prepared?.error || "没有找到可朗读的公众号正文");
  }

  const sentences = normalizeSentences(prepared.sentences);
  if (sentences.length === 0) {
    throw new Error("没有识别到可朗读的句子");
  }

  const articleKey = String(prepared.articleKey || "");
  const startIndex = await getStoredProgressIndex(articleKey, sentences.length);

  return {
    ok: true,
    status: "ready",
    rate: settings.rate,
    index: startIndex + 1,
    total: sentences.length,
    title: prepared.title || "公众号文章",
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
  source = "selection",
  startIndex = 0,
  articleKey = ""
) {
  assertTabId(tabId);

  const rate = normalizeRate(requestedRate ?? settings.rate);
  settings.rate = rate;
  await chrome.storage.local.set({ [RATE_STORAGE_KEY]: rate });

  return startPreparedReading(
    tabId,
    sentences,
    title || (source === "article" ? "公众号文章" : "从选中处播放"),
    rate,
    source,
    startIndex,
    articleKey
  );
}

async function startPreparedReading(tabId, sentences, title, rate, source, startIndex = 0, articleKey = "") {
  const cleanSentences = normalizeSentences(sentences);
  if (cleanSentences.length === 0) {
    throw new Error("没有识别到可朗读的句子");
  }

  const normalizedStartIndex = clamp(Math.round(Number(startIndex) || 0), 0, cleanSentences.length - 1);

  await stopReading({ keepSettings: true });

  session = {
    tabId,
    sentences: cleanSentences,
    index: normalizedStartIndex,
    rate,
    status: "playing",
    needsRestart: false,
    title: title || "",
    source,
    articleKey: source === "article" ? String(articleKey || "") : "",
    error: ""
  };

  await speakCurrentSentence();
  return getState(tabId);
}

async function stopReading(options = {}) {
  const tabId = session?.tabId;
  if (session?.status !== "completed") {
    await saveSessionProgress().catch(() => {});
  }

  speechToken += 1;
  chrome.tts.stop();

  if (tabId) {
    await sendToTab(tabId, { type: MESSAGE.CLEAR }).catch(() => {});
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
  chrome.tts.stop();
  session = null;

  await saveProgress;
}

async function togglePause() {
  if (!session) {
    return getState();
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

  return getState(session.tabId);
}

async function jumpBy(delta) {
  if (!session) {
    return getState();
  }

  const nextIndex = clamp(session.index + delta, 0, session.sentences.length - 1);
  if (nextIndex === session.index && session.status !== "paused") {
    return getState(session.tabId);
  }

  session.index = nextIndex;
  session.status = "playing";
  session.needsRestart = false;
  speechToken += 1;
  chrome.tts.stop();
  await speakCurrentSentence();
  return getState(session.tabId);
}

async function seekTo(indexValue) {
  if (!session) {
    return getState();
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
    await sendToTab(session.tabId, {
      type: MESSAGE.HIGHLIGHT,
      id: sentence.id,
      index: session.index,
      total: session.sentences.length
    }).catch(() => {});
    await saveSessionProgress().catch(() => {});
    await sendPlayerState(session.tabId);
    return getState(session.tabId);
  }

  session.status = "playing";
  session.needsRestart = false;
  await speakCurrentSentence();
  return getState(session.tabId);
}

async function setRate(rateValue) {
  const rate = normalizeRate(rateValue);
  settings.rate = rate;
  await chrome.storage.local.set({ [RATE_STORAGE_KEY]: rate });

  if (session) {
    session.rate = rate;
    await sendPlayerState(session.tabId);
  }

  return getState(session?.tabId);
}

async function speakCurrentSentence() {
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

  session.status = "playing";
  session.needsRestart = false;
  session.error = "";

  await sendToTab(session.tabId, {
    type: MESSAGE.HIGHLIGHT,
    id: sentence.id,
    index: session.index,
    total: session.sentences.length
  }).catch(() => {});
  await saveSessionProgress().catch(() => {});
  await sendPlayerState(session.tabId);

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
    if (session && token === speechToken) {
      session.status = "error";
      session.error = error?.message || "朗读失败";
      await sendPlayerState(session.tabId);
    }
  }
}

function handleTtsEvent(token, event) {
  if (!session || token !== speechToken) {
    return;
  }

  if (event.type === "end") {
    session.index += 1;
    if (session.index >= session.sentences.length) {
      void markCompleted();
      return;
    }

    void speakCurrentSentence();
    return;
  }

  if (event.type === "error") {
    session.status = "error";
    session.error = event.errorMessage || "朗读失败";
    void sendPlayerState(session.tabId);
  }
}

async function markCompleted() {
  if (!session) {
    return;
  }

  session.status = "completed";
  await clearSessionProgress().catch(() => {});
  await sendToTab(session.tabId, { type: MESSAGE.CLEAR }).catch(() => {});
  await sendPlayerState(session.tabId);
}

async function ensureContentScript(tabId) {
  try {
    await sendToTab(tabId, { type: MESSAGE.PING });
    return;
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

  await sendToTab(tabId, { type: MESSAGE.PING });
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
  const activeSession = session && (!tabId || session.tabId === tabId);

  if (!activeSession) {
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

async function getStoredProgressIndex(articleKey, total) {
  if (!articleKey || total <= 0) {
    return 0;
  }

  const stored = await chrome.storage.local.get(getProgressStorageKey(articleKey)).catch(() => ({}));
  const progress = stored[getProgressStorageKey(articleKey)];
  if (!progress || progress.articleKey !== articleKey) {
    return 0;
  }

  const index = Math.round(Number(progress.index) || 0);
  return clamp(index, 0, total - 1);
}

function getProgressStorageKey(articleKey) {
  return `${PROGRESS_STORAGE_PREFIX}${articleKey}`;
}

async function sendPlayerState(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  await sendToTab(tabId, {
    type: MESSAGE.PLAYER_STATE,
    state: getState(tabId)
  }).catch(() => {});
}

function buildSpeechText(text) {
  return String(text || "").replace(ENGLISH_TOKEN_RE, (token) => {
    return getSpeechAlias(token) || getFallbackPronunciation(token);
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
