const MESSAGE = {
  GET_STATE: "WECHAT_ARTICLE_TTS_GET_STATE",
  START: "WECHAT_ARTICLE_TTS_START",
  START_PREPARED: "WECHAT_ARTICLE_TTS_START_PREPARED",
  PREPARE_ARTICLE: "WECHAT_ARTICLE_TTS_PREPARE_ARTICLE",
  TOGGLE_PAUSE: "WECHAT_ARTICLE_TTS_TOGGLE_PAUSE",
  NEXT: "WECHAT_ARTICLE_TTS_NEXT",
  PREVIOUS: "WECHAT_ARTICLE_TTS_PREVIOUS",
  SEEK: "WECHAT_ARTICLE_TTS_SEEK",
  SET_RATE: "WECHAT_ARTICLE_TTS_SET_RATE"
};

const elements = {
  titleText: document.querySelector("#titleText"),
  pageHint: document.querySelector("#pageHint"),
  statusText: document.querySelector("#statusText"),
  progressInput: document.querySelector("#progressInput"),
  progressText: document.querySelector("#progressText"),
  startButton: document.querySelector("#startButton"),
  startLabel: document.querySelector("#startLabel"),
  previousButton: document.querySelector("#previousButton"),
  nextButton: document.querySelector("#nextButton"),
  rateInput: document.querySelector("#rateInput"),
  errorText: document.querySelector("#errorText")
};

const DEFAULT_RATE = 1.25;
const MIN_RATE = 0.75;
const MAX_RATE = 2;
const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2];
const PROGRESS_STORAGE_PREFIX = "wechat-article-tts:article-progress:";

let activeTab = null;
let pollTimer = null;
let busy = false;
let lastState = null;
let rateEditing = false;
let rateCommitTimer = null;
let rateRequestId = 0;
let progressEditing = false;
let readyStartIndexExplicit = false;

init();

async function init() {
  activeTab = await getActiveTab();
  updatePageHint();
  bindEvents();
  await refreshState({ prepareWhenIdle: true });
  pollTimer = window.setInterval(refreshState, 1000);
}

function bindEvents() {
  elements.startButton.addEventListener("click", handleMainAction);
  elements.nextButton.addEventListener("click", () => runCommand(MESSAGE.NEXT));
  elements.previousButton.addEventListener("click", () => runCommand(MESSAGE.PREVIOUS));

  elements.rateInput.addEventListener("change", () => commitRateChange());
  elements.progressInput.addEventListener("input", handleProgressInput);
  elements.progressInput.addEventListener("change", commitProgressSeek);
  elements.progressInput.addEventListener("pointerdown", () => {
    progressEditing = true;
  });
  elements.progressInput.addEventListener("blur", () => {
    commitProgressSeek();
  });

  window.addEventListener("unload", () => {
    if (pollTimer) {
      window.clearInterval(pollTimer);
    }
    if (rateCommitTimer) {
      window.clearTimeout(rateCommitTimer);
    }
  });
}

function handleMainAction() {
  const status = lastState?.status;
  if (status === "starting") {
    return;
  }

  if (["playing", "paused"].includes(status)) {
    return runCommand(MESSAGE.TOGGLE_PAUSE);
  }

  if (status === "busy") {
    return runCommand(MESSAGE.START, { takeover: true });
  }

  if (status === "ready") {
    return startPreparedArticle();
  }

  return runCommand(MESSAGE.START);
}

async function runCommand(type, extra = {}) {
  clearError();

  if (!activeTab?.id) {
    renderError("没有找到当前标签页");
    return;
  }

  if (!isSupportedUrl(activeTab.url)) {
    renderError("请在 mp.weixin.qq.com 的公众号文章页使用");
    return;
  }

  setBusy(true);
  const previousState = lastState;

  try {
    const response = await chrome.runtime.sendMessage({
      type,
      tabId: activeTab.id,
      rate: getRateInputValue(),
      ...extra
    });

    if (!response?.ok) {
      throw new Error(response?.error || "操作失败");
    }

    if (shouldRecoverPausedArticleCommand(type, previousState, response)) {
      await recoverPausedArticleCommand(previousState);
      return;
    }

    renderState(response);
  } catch (error) {
    renderError(error?.message || "操作失败");
  } finally {
    setBusy(false);
  }
}

function shouldRecoverPausedArticleCommand(type, previousState, response) {
  return (
    type === MESSAGE.TOGGLE_PAUSE &&
    response?.status === "idle" &&
    previousState?.status === "paused" &&
    previousState.source === "article" &&
    Boolean(previousState.articleKey) &&
    Number(previousState.total) > 0 &&
    Number(previousState.index) > 0
  );
}

async function recoverPausedArticleCommand(previousState) {
  const total = getSafeProgressTotal(previousState.total);
  const currentIndex = getSafeProgressIndex(previousState.index, total);

  await saveReadyProgress(previousState.articleKey, currentIndex - 1, total, previousState.title || "");

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.START,
    tabId: activeTab.id,
    rate: getRateInputValue()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "操作失败");
  }

  renderState(response);
}

async function refreshState(options = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.GET_STATE,
      tabId: activeTab?.id
    });

    if (response?.ok) {
      if (response.status === "idle" && isSupportedUrl(activeTab?.url)) {
        if (options.prepareWhenIdle) {
          const prepared = await prepareReadyArticle();
          if (prepared?.ok) {
            return;
          }
        }

        if (lastState?.status === "ready") {
          return;
        }
      }

      renderState(response);
    }
  } catch (error) {
    renderError(error?.message || "无法读取朗读状态");
  }
}

async function prepareReadyArticle() {
  if (!activeTab?.id || !isSupportedUrl(activeTab.url)) {
    return null;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.PREPARE_ARTICLE,
      tabId: activeTab.id
    });

    if (!response?.ok) {
      throw new Error(response?.error || "没有找到可朗读的公众号正文");
    }

    readyStartIndexExplicit = false;
    renderState(response);
    return response;
  } catch (error) {
    renderError(error?.message || "没有找到可朗读的公众号正文");
    return null;
  }
}

async function startPreparedArticle(takeover = false) {
  clearError();

  if (!activeTab?.id) {
    renderError("没有找到当前标签页");
    return;
  }

  if (!isSupportedUrl(activeTab.url)) {
    renderError("请在 mp.weixin.qq.com 的公众号文章页使用");
    return;
  }

  if (!Array.isArray(lastState?.sentences) || lastState.sentences.length === 0) {
    await runCommand(MESSAGE.START, { takeover });
    return;
  }

  setBusy(true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.START_PREPARED,
      tabId: activeTab.id,
      title: lastState.title || "公众号文章",
      sentences: lastState.sentences,
      articleKey: lastState.articleKey || "",
      rate: getRateInputValue(),
      startIndex: getSelectedProgressIndex() - 1,
      takeover,
      explicitStartIndex: readyStartIndexExplicit
    });

    if (!response?.ok) {
      throw new Error(response?.error || "操作失败");
    }

    renderState(response);
    readyStartIndexExplicit = false;
  } catch (error) {
    renderError(error?.message || "操作失败");
  } finally {
    setBusy(false);
  }
}

function renderState(state) {
  lastState = state;
  if (state.status !== "ready") {
    readyStartIndexExplicit = false;
  }

  const supported = isSupportedUrl(activeTab?.url);
  const total = getSafeProgressTotal(state.total);
  const progressIndex = getSafeProgressIndex(state.index, total);
  const isStarting = state.status === "starting";
  const canNavigate = ["playing", "paused", "completed"].includes(state.status) && total > 0;

  if (!rateEditing && document.activeElement !== elements.rateInput) {
    updateRateControl(state.rate || DEFAULT_RATE);
  }

  elements.startButton.disabled = busy || !supported || isStarting;
  elements.previousButton.disabled = busy || !supported || !canNavigate;
  elements.nextButton.disabled = busy || !supported || !canNavigate;
  elements.rateInput.disabled = busy;
  elements.progressInput.disabled = busy || !supported || isStarting || total <= 0;

  elements.startButton.dataset.mode = state.status === "playing" ? "pause" : "play";
  elements.startLabel.textContent = getMainActionLabel(state);

  elements.titleText.textContent = getTitleLabel(state);
  elements.statusText.textContent = getStatusLabel(state);
  elements.progressText.textContent = `${progressIndex} / ${total}`;
  if (!progressEditing && document.activeElement !== elements.progressInput) {
    updateProgressControl(progressIndex, total);
  }

  if (state.error) {
    renderError(state.error);
  }
}

async function commitRateChange() {
  if (rateCommitTimer) {
    window.clearTimeout(rateCommitTimer);
    rateCommitTimer = null;
  }

  if (!activeTab?.id || !isSupportedUrl(activeTab.url)) {
    rateEditing = false;
    return;
  }

  const requestId = (rateRequestId += 1);
  const rate = getRateInputValue();
  const previousState = lastState;

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.SET_RATE,
      tabId: activeTab.id,
      rate
    });

    if (!response?.ok) {
      throw new Error(response?.error || "语速修改失败");
    }

    if (requestId === rateRequestId) {
      rateEditing = false;
      if (previousState?.status === "ready") {
        renderState({
          ...previousState,
          rate
        });
      } else {
        renderState(response);
      }
    }
  } catch (error) {
    if (requestId === rateRequestId) {
      rateEditing = false;
      renderError(error?.message || "语速修改失败");
    }
  }
}

function updateProgressControl(index, total) {
  const safeTotal = getSafeProgressTotal(total);
  const safeIndex = getSafeProgressIndex(index, safeTotal);
  elements.progressInput.min = safeTotal > 0 ? "1" : "0";
  elements.progressInput.max = String(safeTotal);
  elements.progressInput.value = String(safeIndex);
  elements.progressInput.style.setProperty("--wechat-tts-progress", `${getProgressPercentByValue(safeIndex, safeTotal)}%`);
}

function handleProgressInput() {
  if (elements.progressInput.disabled) {
    return;
  }

  progressEditing = true;
  const total = getSafeProgressTotal(elements.progressInput.max);
  const index = getSafeProgressIndex(elements.progressInput.value, total);
  elements.progressInput.value = String(index);
  elements.progressInput.style.setProperty("--wechat-tts-progress", `${getProgressPercentByValue(index, total)}%`);
  elements.progressText.textContent = `${index} / ${total}`;
}

async function commitProgressSeek() {
  if (!progressEditing) {
    return;
  }

  const total = getSafeProgressTotal(elements.progressInput.max);
  const targetIndex = getSafeProgressIndex(elements.progressInput.value, total);
  progressEditing = false;

  if (total <= 0) {
    updateProgressControl(0, 0);
    return;
  }

  if (!["playing", "paused", "completed"].includes(lastState?.status)) {
    readyStartIndexExplicit = true;
    const nextState = {
      ...(lastState || {}),
      ok: true,
      status: lastState?.status && lastState.status !== "idle" ? lastState.status : "ready",
      index: targetIndex,
      total
    };

    await saveReadyProgress(nextState.articleKey, targetIndex - 1, total, nextState.title || "");
    renderState(nextState);
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.SEEK,
      tabId: activeTab?.id,
      index: targetIndex
    });

    if (!response?.ok) {
      throw new Error(response?.error || "跳转失败");
    }

    renderState(response);
  } catch (error) {
    renderError(error?.message || "跳转失败");
    renderState(lastState);
  }
}

async function saveReadyProgress(articleKey, index, total, title) {
  if (!articleKey || total <= 0 || !chrome.storage?.local) {
    return;
  }

  const safeTotal = getSafeProgressTotal(total);
  const safeIndex = Math.min(safeTotal - 1, Math.max(0, Math.round(Number(index) || 0)));
  await chrome.storage.local.set({
    [`${PROGRESS_STORAGE_PREFIX}${articleKey}`]: {
      articleKey,
      index: safeIndex,
      total: safeTotal,
      title,
      updatedAt: Date.now()
    }
  }).catch(() => {});
}

function updateRateControl(rate) {
  const normalized = normalizeRate(rate);
  elements.rateInput.value = String(normalized);
}

function getRateInputValue() {
  return normalizeRate(elements.rateInput.value);
}

function normalizeRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_RATE;
  }
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, numeric));
  return RATE_OPTIONS.reduce((closest, option) => {
    return Math.abs(option - clamped) < Math.abs(closest - clamped) ? option : closest;
  }, DEFAULT_RATE);
}

function getProgressPercentByValue(index, total) {
  const safeTotal = getSafeProgressTotal(total);
  if (safeTotal <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (getSafeProgressIndex(index, safeTotal) / safeTotal) * 100));
}

function getSelectedProgressIndex() {
  const total = getSafeProgressTotal(elements.progressInput.max || lastState?.total);
  return getSafeProgressIndex(elements.progressInput.value || lastState?.index, total);
}

function getSafeProgressTotal(total) {
  return Math.max(0, Math.round(Number(total) || 0));
}

function getSafeProgressIndex(index, total) {
  const safeTotal = getSafeProgressTotal(total);
  if (safeTotal <= 0) {
    return 0;
  }
  return Math.min(safeTotal, Math.max(1, Math.round(Number(index) || 1)));
}

function getMainActionLabel(state) {
  switch (state.status) {
    case "playing":
      return "暂停";
    case "starting":
      return "正在启动";
    case "paused":
      return "继续";
    case "completed":
      return "重新开始";
    case "busy":
      return "接管";
    case "ready":
      return "开始";
    default:
      return "开始";
  }
}

function getStatusLabel(state) {
  if (!isSupportedUrl(activeTab?.url)) {
    return "当前不是公众号文章页";
  }

  switch (state.status) {
    case "playing":
      return "正在朗读";
    case "starting":
      return "正在启动";
    case "paused":
      return "已暂停";
    case "ready":
      return Number(state.index) > 1 ? "准备续播" : "准备播放";
    case "completed":
      return "朗读完成";
    case "error":
      return "朗读出错";
    case "busy":
      return "另一标签页正在朗读";
    default:
      return "准备就绪";
  }
}

function getTitleLabel(state) {
  if (state.status === "busy") {
    return state.activeTitle ? `正在朗读：${state.activeTitle}` : "另一标签页正在朗读";
  }

  if (state.title && state.status !== "idle") {
    return state.title;
  }

  return "逐句高亮阅读";
}

function updatePageHint() {
  if (!activeTab) {
    elements.pageHint.textContent = "没有找到当前标签页";
    return;
  }

  elements.pageHint.textContent = isSupportedUrl(activeTab.url)
    ? "当前页可朗读"
    : "请切换到微信公众号文章页";
}

function setBusy(isBusy) {
  busy = isBusy;
  if (lastState) {
    renderState(lastState);
  }
}

function clearError() {
  elements.errorText.textContent = "";
}

function renderError(message) {
  elements.errorText.textContent = message;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tabs[0] || null;
}

function isSupportedUrl(url) {
  return typeof url === "string" && url.startsWith("https://mp.weixin.qq.com/");
}
