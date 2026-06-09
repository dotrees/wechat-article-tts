(() => {
  const CONTENT_SCRIPT_VERSION = "2026-06-09.content-focus-v6";
  const loadedVersion = window.__wechatArticleTtsLoadedVersion || (window.__wechatArticleTtsLoaded ? "legacy" : "");
  if (loadedVersion === CONTENT_SCRIPT_VERSION) {
    return;
  }

  if (typeof window.__wechatArticleTtsCleanup === "function") {
    try {
      window.__wechatArticleTtsCleanup();
    } catch (_error) {
      // A newer content script will clean visible artifacts below.
    }
  }

  window.__wechatArticleTtsLoaded = true;
  window.__wechatArticleTtsLoadedVersion = CONTENT_SCRIPT_VERSION;

  const MESSAGE = {
    GET_STATE: "WECHAT_ARTICLE_TTS_GET_STATE",
    PING: "WECHAT_ARTICLE_TTS_PING",
    PREPARE: "WECHAT_ARTICLE_TTS_PREPARE",
    HIGHLIGHT: "WECHAT_ARTICLE_TTS_HIGHLIGHT",
    CLEAR: "WECHAT_ARTICLE_TTS_CLEAR",
    START_PREPARED: "WECHAT_ARTICLE_TTS_START_PREPARED",
    STOP: "WECHAT_ARTICLE_TTS_STOP",
    TOGGLE_PAUSE: "WECHAT_ARTICLE_TTS_TOGGLE_PAUSE",
    NEXT: "WECHAT_ARTICLE_TTS_NEXT",
    PREVIOUS: "WECHAT_ARTICLE_TTS_PREVIOUS",
    SEEK: "WECHAT_ARTICLE_TTS_SEEK",
    SET_RATE: "WECHAT_ARTICLE_TTS_SET_RATE",
    PLAYER_STATE: "WECHAT_ARTICLE_TTS_PLAYER_STATE"
  };

  const CONTENT_MESSAGE = {
    PING: "WECHAT_ARTICLE_TTS_CONTENT_PING",
    PREPARE: "WECHAT_ARTICLE_TTS_CONTENT_PREPARE",
    HIGHLIGHT: "WECHAT_ARTICLE_TTS_CONTENT_HIGHLIGHT",
    CLEAR: "WECHAT_ARTICLE_TTS_CONTENT_CLEAR",
    PLAYER_STATE: "WECHAT_ARTICLE_TTS_CONTENT_PLAYER_STATE"
  };

  const EXCLUDED_TAGS = new Set([
    "AUDIO",
    "BUTTON",
    "CANVAS",
    "IFRAME",
    "IMG",
    "INPUT",
    "MP-COMMON-PROFILE",
    "NOSCRIPT",
    "OPTION",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "SUP",
    "SVG",
    "TEXTAREA",
    "VIDEO"
  ]);

  const BOUNDARY_TAGS = new Set([
    "ARTICLE",
    "BLOCKQUOTE",
    "DD",
    "DIV",
    "DT",
    "FIGCAPTION",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "P",
    "SECTION",
    "TD",
    "TH"
  ]);
  const BOUNDARY_SELECTOR = Array.from(BOUNDARY_TAGS)
    .map((tag) => tag.toLowerCase())
    .join(",");
  const WECHAT_PAGE_TITLE_SELECTOR = [
    "#activity-name",
    "#js_text_title",
    "#js_video_page_title",
    "#js_audio_title"
  ].join(",");
  const WECHAT_PAGE_METADATA_SELECTOR = [
    WECHAT_PAGE_TITLE_SELECTOR,
    "#meta_content"
  ].join(",");

  const TERMINATORS = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);
  const CLOSERS = new Set(["”", "’", "」", "』", "）", ")", "】", "]", "》", ">", "〕", "}"]);
  const READABLE_RE = /[\p{Script=Han}A-Za-z0-9]/u;
  const DEFAULT_RATE = 1.25;
  const MIN_RATE = 0.75;
  const MAX_RATE = 1.5;
  const RATE_OPTIONS = [0.75, 1, 1.25, 1.5];
  const PROGRESS_STORAGE_PREFIX = "wechat-article-tts:article-progress:";
  const TAIL_MIN_CHARS = 800;
  const TAIL_HIGH_MIN_RATIO = 0.4;
  const TAIL_MEDIUM_MIN_RATIO = 0.55;
  const TAIL_LOW_MIN_RATIO = 0.62;
  const POST_CUTOFF_LONG_BLOCK_LENGTH = 80;
  const REFERENCE_MARKERS = new Set(["参考资料", "参考文献", "资料来源", "参考来源", "REFERENCES", "REFERENCE"]);
  const END_MARKERS = new Set(["END", "THEEND", "全文完", "全文结束", "完"]);
  const TAIL_MEDIUM_PATTERNS = [
    /本文内容为作者独立观点/,
    /不代表.*公众号立场/,
    /不构成.*投资建议/,
    /版权归原作者/,
    /如有(?:疑问|侵权).*联系/,
    /联系我们/,
    /微信号[:：]?/,
    /长按识别.*二维码/,
    /扫码.*关注/,
    /关注.*公众号/
  ];
  const TAIL_MEDIUM_HEADING_MARKERS = new Set([
    "推荐阅读",
    "往期文章",
    "商务合作",
    "合作联系",
    "投稿",
    "转载",
    "关注我们",
    "相关阅读",
    "延伸阅读"
  ]);
  const TAIL_LOW_PATTERNS = [
    /作者简介/,
    /作者介绍/,
    /关于作者/,
    /编委会/,
    /致谢/,
    /特别致谢/,
    /鸣谢/,
    /共创者/,
    /顾问/,
    /联系方式/,
    /联系电话/,
    /联系邮箱/
  ];

  let readerState = {
    prepared: false,
    root: null,
    sentences: []
  };

  let selectionToolbar = null;
  let readingFocusFrame = null;
  let readingFocusTarget = null;
  let readingFocusUpdateFrame = null;
  let lastSelectionRange = null;
  let suppressedSelectionRange = null;
  let selectionToolbarInteracting = false;
  let toolbarUpdateTimer = null;
  let floatingPlayer = null;
  let floatingPlayerState = null;
  let floatingRateEditing = false;
  let floatingRateCommitTimer = null;
  let floatingBoundsTimer = null;
  let floatingProgressEditing = false;
  let floatingReadyStartIndex = 0;
  let floatingReadyStartIndexExplicit = false;

  cleanupPreviousContentScriptArtifacts();
  installSelectionToolbar();
  installFloatingPlayer();
  installReadingFocusFrameRefreshers();
  installPageLifecycleProgressSaver();
  runAsyncSafely(initializeAutoFloatingPlayer);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }

    const messageKind = getContentMessageKind(message);
    if (!messageKind) {
      return false;
    }

    try {
      switch (messageKind) {
        case "ping":
          sendResponse({ ok: true, version: CONTENT_SCRIPT_VERSION });
          break;
        case "prepare":
          sendResponse(prepareArticle());
          break;
        case "highlight":
          sendResponse(highlightSentence(message.id, message.index, message.total));
          break;
        case "clear":
          sendResponse(clearHighlight());
          break;
        case "playerState":
          renderFloatingPlayer(message.state);
          sendResponse({ ok: true });
          break;
        default:
          return false;
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || "页面处理失败"
      });
    }

    return false;
  });

  function cleanupPreviousContentScriptArtifacts() {
    removeSentenceMarkup(document.body || document.documentElement);

    for (const element of document.querySelectorAll(
      ".wechat-tts-selection-toolbar, #wechatTtsFloatingPlayer, .wechat-tts-floating-player"
    )) {
      element.remove();
    }

    for (const element of document.querySelectorAll(".wechat-tts-current-sentence, [data-wechat-tts-active]")) {
      element.classList.remove("wechat-tts-current-sentence");
      delete element.dataset.wechatTtsActive;
    }

    for (const frame of document.querySelectorAll(".wechat-tts-focus-frame")) {
      frame.remove();
    }

    if (window.CSS?.highlights) {
      CSS.highlights.delete("wechat-tts-current-sentence");
    }

    delete document.documentElement.dataset.wechatTtsProgress;
  }

  function getContentMessageKind(message) {
    if (message.targetVersion && message.targetVersion !== CONTENT_SCRIPT_VERSION) {
      return "";
    }

    switch (message.type) {
      case CONTENT_MESSAGE.PING:
      case MESSAGE.PING:
        return "ping";
      case CONTENT_MESSAGE.PREPARE:
      case MESSAGE.PREPARE:
        return "prepare";
      case CONTENT_MESSAGE.HIGHLIGHT:
      case MESSAGE.HIGHLIGHT:
        return "highlight";
      case CONTENT_MESSAGE.CLEAR:
      case MESSAGE.CLEAR:
        return "clear";
      case CONTENT_MESSAGE.PLAYER_STATE:
      case MESSAGE.PLAYER_STATE:
        return "playerState";
      default:
        return "";
    }
  }

  function installReadingFocusFrameRefreshers() {
    const scheduleRefresh = () => scheduleReadingFocusFrameUpdate();

    window.addEventListener("scroll", scheduleRefresh, true);
    document.addEventListener("scroll", scheduleRefresh, true);
    window.addEventListener("resize", scheduleRefresh);
    window.visualViewport?.addEventListener("scroll", scheduleRefresh);
    window.visualViewport?.addEventListener("resize", scheduleRefresh);

    window.__wechatArticleTtsCleanup = () => {
      window.removeEventListener("scroll", scheduleRefresh, true);
      document.removeEventListener("scroll", scheduleRefresh, true);
      window.removeEventListener("resize", scheduleRefresh);
      window.visualViewport?.removeEventListener("scroll", scheduleRefresh);
      window.visualViewport?.removeEventListener("resize", scheduleRefresh);
      clearReadingFocusTarget();
      hideReadingFocusFrame();
    };
  }

  function prepareArticle() {
    const root = findArticleRoot();
    if (!root) {
      return {
        ok: false,
        error: "没有找到微信公众号正文容器"
      };
    }

    if (
      readerState.prepared &&
      readerState.root === root &&
      readerState.sentences.length > 0 &&
      hasSentenceMarkup(root)
    ) {
      return buildPreparedResponse();
    }

    removeExistingMarkup(root);

    const cutoffElement = findArticleReadCutoff(root);
    const collector = createSentenceCollector();
    processNode(root, collector, { cutoffElement });
    collector.finishSentence();

    const sentences = collector.getSentences();
    readerState = {
      prepared: true,
      root,
      sentences
    };

    return buildPreparedResponse();
  }

  function findArticleRoot() {
    return (
      document.querySelector("#js_content") ||
      document.querySelector("article") ||
      document.querySelector("main")
    );
  }

  function hasSentenceMarkup(root) {
    return Boolean(root.querySelector("span.wechat-tts-sentence[data-wechat-tts-sentence-id]"));
  }

  function installSelectionToolbar() {
    selectionToolbar = document.createElement("div");
    selectionToolbar.className = "wechat-tts-selection-toolbar";
    selectionToolbar.dataset.wechatTtsVersion = CONTENT_SCRIPT_VERSION;
    selectionToolbar.setAttribute("role", "toolbar");
    selectionToolbar.setAttribute("aria-label", "选中文字朗读");
    selectionToolbar.hidden = true;
    selectionToolbar.innerHTML = `
      <button
        type="button"
        class="wechat-tts-selection-action"
        data-wechat-tts-action="play"
        title="从这里开始朗读后文"
        aria-label="从这里开始朗读后文"
      >
        <span class="wechat-tts-selection-play" aria-hidden="true"></span>
        <span class="wechat-tts-selection-title">从这里读</span>
      </button>
      <label class="wechat-tts-selection-rate">
        <span class="wechat-tts-sr-only">朗读语速</span>
        <select aria-label="朗读语速">
          <option value="0.75">0.75x</option>
          <option value="1">1.00x</option>
          <option value="1.25" selected>1.25x</option>
          <option value="1.5">1.50x</option>
        </select>
      </label>
    `;

    selectionToolbar.addEventListener("mousedown", (event) => {
      selectionToolbarInteracting = true;
      if (!event.target.closest(".wechat-tts-selection-rate select")) {
        event.preventDefault();
      }
    });

    selectionToolbar.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!selectionToolbar?.contains(document.activeElement)) {
          selectionToolbarInteracting = false;
        }
      }, 0);
    });

    selectionToolbar.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-wechat-tts-action]");
      if (!button) {
        return;
      }

      runAsyncSafely(() => handleToolbarAction(button.dataset.wechatTtsAction));
    });

    (document.body || document.documentElement).append(selectionToolbar);

    document.addEventListener("selectionchange", scheduleToolbarUpdate);
    document.addEventListener("mouseup", scheduleToolbarUpdate);
    document.addEventListener("keyup", scheduleToolbarUpdate);
    document.addEventListener("pointerdown", (event) => {
      if (!selectionToolbar?.contains(event.target)) {
        selectionToolbarInteracting = false;
        if (!selectionToolbar?.hidden) {
          suppressedSelectionRange = lastSelectionRange ? lastSelectionRange.cloneRange() : null;
          hideSelectionToolbar();
        }
      }
    }, true);
    window.addEventListener("scroll", scheduleToolbarUpdate, { passive: true });
    window.addEventListener("resize", scheduleToolbarUpdate);
  }

  function installFloatingPlayer() {
    floatingPlayer = document.createElement("div");
    floatingPlayer.id = "wechatTtsFloatingPlayer";
    floatingPlayer.className = "wechat-tts-floating-player";
    floatingPlayer.dataset.wechatTtsVersion = CONTENT_SCRIPT_VERSION;
    floatingPlayer.hidden = true;
    floatingPlayer.setAttribute("role", "region");
    floatingPlayer.setAttribute("aria-label", "公众号边听边读播放器");
    floatingPlayer.innerHTML = `
      <div class="wechat-tts-floating-meta">
        <span class="wechat-tts-floating-kicker">公众号边听边读</span>
        <span class="wechat-tts-floating-title"></span>
      </div>
      <div class="wechat-tts-floating-controls">
        <button type="button" class="wechat-tts-floating-icon" data-wechat-tts-player-action="previous" title="上一句" aria-label="上一句">‹</button>
        <button type="button" class="wechat-tts-floating-toggle" data-wechat-tts-player-action="toggle" title="开始、暂停或继续">开始</button>
        <button type="button" class="wechat-tts-floating-icon" data-wechat-tts-player-action="next" title="下一句" aria-label="下一句">›</button>
      </div>
      <label class="wechat-tts-floating-rate">
        <span>语速</span>
        <select>
          <option value="0.75">0.75x</option>
          <option value="1">1.00x</option>
          <option value="1.25" selected>1.25x</option>
          <option value="1.5">1.50x</option>
        </select>
      </label>
      <label class="wechat-tts-floating-progressbar">
        <span class="wechat-tts-sr-only">阅读进度</span>
        <input type="range" min="0" max="0" step="1" value="0">
      </label>
      <div class="wechat-tts-floating-status">
        <span class="wechat-tts-floating-progress">0 / 0</span>
        <span class="wechat-tts-floating-state">准备就绪</span>
      </div>
    `;

    floatingPlayer.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-wechat-tts-player-action]");
      if (!button) {
        return;
      }

      runAsyncSafely(() => handleFloatingPlayerAction(button.dataset.wechatTtsPlayerAction));
    });

    const rateSelect = floatingPlayer.querySelector(".wechat-tts-floating-rate select");
    rateSelect.addEventListener("change", () => runAsyncSafely(commitFloatingRate));

    const progressInput = getFloatingProgressInput();
    progressInput.addEventListener("input", handleFloatingProgressInput);
    progressInput.addEventListener("change", () => runAsyncSafely(commitFloatingProgressSeek));
    progressInput.addEventListener("pointerdown", () => {
      floatingProgressEditing = true;
    });
    progressInput.addEventListener("blur", () => {
      runAsyncSafely(commitFloatingProgressSeek);
    });

    (document.body || document.documentElement).append(floatingPlayer);
    document.addEventListener("keydown", handleDocumentKeydown);
    window.addEventListener("resize", scheduleFloatingPlayerBoundsUpdate);
    window.addEventListener("orientationchange", scheduleFloatingPlayerBoundsUpdate);
    scheduleFloatingPlayerBoundsUpdate();
  }

  async function initializeAutoFloatingPlayer() {
    const state = await requestFloatingPlayerState();
    let prepared = null;

    if (state?.ok && state.status === "busy") {
      return;
    }

    if (state?.ok && state.status !== "idle" && Number(state.total) > 0) {
      if (state.source === "article") {
        prepared = prepareArticle();
        if (prepared.ok && state.articleKey && prepared.articleKey !== state.articleKey) {
          await sendRuntimeMessage({ type: MESSAGE.STOP });
        } else if (Number.isInteger(state.currentId)) {
          highlightSentence(state.currentId, Math.max(0, Number(state.index) - 1), state.total);
          return;
        } else {
          return;
        }
      } else {
        return;
      }
    }

    if (!prepared) {
      prepared = prepareArticle();
    }
    if (!prepared.ok || prepared.sentences.length === 0) {
      return;
    }

    const storedProgress = await loadArticleProgress(prepared.articleKey, prepared.sentences.length, prepared.title);
    floatingReadyStartIndex = storedProgress ? storedProgress.index : 0;
    floatingReadyStartIndexExplicit = false;
    renderFloatingPlayer({
      ok: true,
      status: "ready",
      rate: state?.rate || DEFAULT_RATE,
      index: storedProgress ? storedProgress.index + 1 : 0,
      total: prepared.sentences.length,
      title: prepared.title,
      source: "article",
      articleKey: prepared.articleKey,
      currentId: null,
      sentenceText: "准备播放",
      error: ""
    });
  }

  function scheduleToolbarUpdate() {
    if (toolbarUpdateTimer) {
      window.clearTimeout(toolbarUpdateTimer);
    }

    toolbarUpdateTimer = window.setTimeout(updateSelectionToolbar, 40);
  }

  function updateSelectionToolbar() {
    const selectionInfo = getSelectionInfo();
    if (!selectionInfo) {
      if (selectionToolbarInteracting && lastSelectionRange) {
        return;
      }

      suppressedSelectionRange = null;
      hideSelectionToolbar();
      return;
    }

    if (suppressedSelectionRange && areRangesEqual(suppressedSelectionRange, selectionInfo.range)) {
      hideSelectionToolbar();
      return;
    }

    suppressedSelectionRange = null;
    lastSelectionRange = selectionInfo.range.cloneRange();
    showSelectionToolbar(selectionInfo.rect);
  }

  async function handleToolbarAction(action) {
    if (action === "pause") {
      await sendRuntimeMessage({ type: MESSAGE.TOGGLE_PAUSE });
      return;
    }

    if (action === "stop") {
      await sendRuntimeMessage({ type: MESSAGE.STOP });
      return;
    }

    if (action !== "play") {
      return;
    }

    const range = lastSelectionRange || getSelectionInfo()?.range;
    if (!range) {
      hideSelectionToolbar();
      return;
    }

    const selectedRange = range.cloneRange();
    const prepared = prepareArticleStartFromRange(range);
    if (!prepared.ok) {
      return;
    }

    const response = await sendRuntimeMessage({
      type: MESSAGE.START_PREPARED,
      title: prepared.title,
      sentences: prepared.sentences,
      articleKey: prepared.articleKey,
      rate: getSelectionRateValue(),
      startIndex: prepared.startIndex,
      explicitStartIndex: true
    });

    if (response?.status === "busy") {
      renderFloatingPlayer(response);
      return;
    }

    if (!response?.ok) {
      return;
    }

    suppressedSelectionRange = selectedRange;
    selectionToolbarInteracting = false;
    hideSelectionToolbar();
    clearNativeSelection();
  }

  function prepareArticleStartFromRange(range) {
    const root = findArticleRoot();
    if (!root || !isRangeInsideRoot(range, root)) {
      return { ok: false, error: "请选择公众号正文里的文字" };
    }

    const anchor = createSelectionStartAnchor(range);
    try {
      const prepared = prepareArticle();
      if (!prepared.ok || prepared.sentences.length === 0) {
        return { ok: false, error: prepared.error || "没有识别到可朗读的句子" };
      }

      const startIndex = getSentenceIndexFromSelectionAnchor(anchor, root, prepared.sentences);
      if (startIndex < 0) {
        return { ok: false, error: "没有识别到选中位置对应的句子" };
      }

      return {
        ...prepared,
        startIndex
      };
    } finally {
      anchor.remove();
    }
  }

  function createSelectionStartAnchor(range) {
    const anchor = document.createElement("span");
    anchor.dataset.wechatTtsSelectionAnchor = "true";
    anchor.hidden = true;

    const insertionRange = range.cloneRange();
    insertionRange.collapse(true);
    insertionRange.insertNode(anchor);
    insertionRange.detach?.();
    return anchor;
  }

  function getSentenceIndexFromSelectionAnchor(anchor, root, sentences) {
    const containingSpan = anchor.closest?.("span.wechat-tts-sentence");
    const containingId = containingSpan && root.contains(containingSpan)
      ? getSentenceIdFromSpan(containingSpan)
      : null;
    if (Number.isInteger(containingId)) {
      return getPreparedSentenceIndexById(sentences, containingId);
    }

    const adjacentSpans = getAdjacentSentenceSpans(anchor, root);
    const previousId = adjacentSpans.previous ? getSentenceIdFromSpan(adjacentSpans.previous) : null;
    const nextId = adjacentSpans.next ? getSentenceIdFromSpan(adjacentSpans.next) : null;
    const targetId = Number.isInteger(previousId) && previousId === nextId ? previousId : nextId;

    return Number.isInteger(targetId) ? getPreparedSentenceIndexById(sentences, targetId) : -1;
  }

  function getAdjacentSentenceSpans(anchor, root) {
    let previous = null;
    let next = null;

    for (const span of root.querySelectorAll("span.wechat-tts-sentence")) {
      const position = anchor.compareDocumentPosition(span);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        next = span;
        break;
      }

      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        previous = span;
      }
    }

    return { previous, next };
  }

  function getSentenceIdFromSpan(span) {
    const id = Number(span?.dataset?.wechatTtsSentenceId);
    return Number.isInteger(id) ? id : null;
  }

  function getPreparedSentenceIndexById(sentences, id) {
    return sentences.findIndex((sentence) => Number(sentence.id) === id);
  }

  function createSentenceCollector() {
    const sentenceTexts = [];
    let currentId = 0;
    let currentHasText = false;

    function appendText(text) {
      if (!text) {
        return;
      }

      sentenceTexts[currentId] = `${sentenceTexts[currentId] || ""}${text}`;
      if (READABLE_RE.test(text)) {
        currentHasText = true;
      }
    }

    function finishSentence() {
      if (!currentHasText) {
        return;
      }

      currentId += 1;
      currentHasText = false;
    }

    function getCurrentId() {
      return currentId;
    }

    function getSentences() {
      return sentenceTexts
        .map((text, id) => ({
          id,
          text: normalizeUtterance(text)
        }))
        .filter((sentence) => isReadableSentence(sentence.text));
    }

    return {
      appendText,
      finishSentence,
      getCurrentId,
      getSentences
    };
  }

  function findArticleReadCutoff(root) {
    return analyzeArticleTail(root).cutoffElement;
  }

  function analyzeArticleTail(root, options = {}) {
    const blocks = collectReadableBlocks(root);
    const candidates = collectTailCutoffCandidates(blocks);
    const selected = selectTailCutoffCandidate(blocks, candidates);

    return {
      ok: true,
      totalBlocks: blocks.length,
      totalChars: blocks.reduce((sum, block) => sum + block.length, 0),
      cutoffElement: selected?.block.element || null,
      cutoffIndex: Number.isInteger(selected?.block.index) ? selected.block.index : -1,
      reason: selected?.reason || "",
      confidence: selected?.confidence || "none",
      candidates,
      blocks: options.includeBlocks ? blocks : []
    };
  }

  function collectReadableBlocks(root) {
    const rawBlocks = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(element) {
        if (shouldSkipElement(element)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (!BOUNDARY_TAGS.has(element.tagName)) {
          return NodeFilter.FILTER_SKIP;
        }

        const text = normalizeUtterance(element.textContent || "");
        if (!isReadableSentence(text)) {
          return NodeFilter.FILTER_SKIP;
        }

        if (hasReadableBoundaryDescendant(element)) {
          return NodeFilter.FILTER_SKIP;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      const element = walker.currentNode;
      rawBlocks.push({ element, text: normalizeUtterance(element.textContent || "") });
    }

    const totalChars = rawBlocks.reduce((sum, block) => sum + getReadableLength(block.text), 0);
    let charsBefore = 0;
    return rawBlocks.map((block, index) => {
      const length = getReadableLength(block.text);
      const enriched = createReadableBlock(block.element, block.text, {
        index,
        total: rawBlocks.length,
        charsBefore,
        charsAfter: Math.max(0, totalChars - charsBefore - length),
        length,
        root
      });
      charsBefore += length;
      return enriched;
    });
  }

  function hasReadableBoundaryDescendant(element) {
    for (const descendant of element.querySelectorAll(BOUNDARY_SELECTOR)) {
      if (
        descendant !== element &&
        !shouldSkipElement(descendant) &&
        isReadableSentence(normalizeUtterance(descendant.textContent || ""))
      ) {
        return true;
      }
    }

    return false;
  }

  function createReadableBlock(element, text, meta) {
    const style = window.getComputedStyle(element);
    const linkTextLength = Array.from(element.querySelectorAll("a"))
      .reduce((sum, link) => sum + getReadableLength(link.textContent || ""), 0);
    const imageCount = element.querySelectorAll("img, svg, mp-common-profile").length;
    const linkDensity = meta.length > 0 ? linkTextLength / meta.length : 0;

    return {
      element,
      text,
      marker: normalizeTailMarker(text),
      length: meta.length,
      index: meta.index,
      total: meta.total,
      ratio: meta.total > 1 ? meta.index / (meta.total - 1) : 0,
      charsBefore: meta.charsBefore,
      charsAfter: meta.charsAfter,
      depth: getElementDepth(element, meta.root),
      tagName: element.tagName,
      className: element.className || "",
      styleText: element.getAttribute("style") || "",
      fontSize: style.fontSize,
      color: style.color,
      textAlign: style.textAlign,
      linkDensity,
      imageCount,
      hasUrl: /(https?:\/\/|www\.)/i.test(text),
      hasQrSignal: imageCount > 0 && /(二维码|扫码|长按识别|关注|公众号|微信)/.test(text),
      hasContactSignal: /(微信号[:：]?|联系电话|联系邮箱|邮箱|电话|商务合作|合作联系|联系我们)/.test(text)
    };
  }

  function collectTailCutoffCandidates(blocks) {
    const candidates = [];

    for (const block of blocks) {
      const highReason = getHighConfidenceTailReason(block);
      if (highReason && isTailCandidatePosition(block, TAIL_HIGH_MIN_RATIO)) {
        candidates.push(createTailCandidate(block, "high", highReason));
        continue;
      }

      const mediumReason = getMediumConfidenceTailReason(block);
      if (mediumReason && isTailCandidatePosition(block, TAIL_MEDIUM_MIN_RATIO)) {
        candidates.push(createTailCandidate(block, "medium", mediumReason));
        continue;
      }

      const lowReason = getLowConfidenceTailReason(block);
      if (
        lowReason &&
        isTailCandidatePosition(block, TAIL_LOW_MIN_RATIO) &&
        hasLowConfidenceTailSupport(blocks, block.index)
      ) {
        candidates.push(createTailCandidate(block, "low", lowReason));
      }
    }

    return candidates;
  }

  function createTailCandidate(block, confidence, reason) {
    return {
      block,
      confidence,
      reason,
      rejectedReason: ""
    };
  }

  function selectTailCutoffCandidate(blocks, candidates) {
    for (const confidence of ["high", "medium", "low"]) {
      for (const candidate of candidates.filter((item) => item.confidence === confidence)) {
        const rejectedReason = getTailCandidateRejectionReason(blocks, candidate);
        if (rejectedReason) {
          candidate.rejectedReason = rejectedReason;
          continue;
        }

        return candidate;
      }
    }

    return null;
  }

  function getHighConfidenceTailReason(block) {
    if (isEndMarkerText(block.text)) {
      return "end-marker";
    }

    if (isReferenceMarkerText(block.text)) {
      return "reference-heading";
    }

    return "";
  }

  function getMediumConfidenceTailReason(block) {
    if (isTailMediumHeadingText(block.text)) {
      return "tail-heading";
    }

    if (TAIL_MEDIUM_PATTERNS.some((pattern) => pattern.test(block.text))) {
      return "tail-noise";
    }

    if (block.hasQrSignal) {
      return "qr-signal";
    }

    if (block.hasContactSignal && block.ratio >= 0.72) {
      return "contact-signal";
    }

    return "";
  }

  function isTailMediumHeadingText(text) {
    const marker = normalizeTailMarker(text);
    const length = getReadableLength(text);

    for (const heading of TAIL_MEDIUM_HEADING_MARKERS) {
      const headingMarker = normalizeTailMarker(heading);
      if (marker === headingMarker) {
        return true;
      }

      if (length <= 30 && marker.startsWith(headingMarker)) {
        return true;
      }
    }

    return false;
  }

  function getLowConfidenceTailReason(block) {
    if (TAIL_LOW_PATTERNS.some((pattern) => pattern.test(block.text))) {
      return "credits-or-author";
    }

    return "";
  }

  function isTailCandidatePosition(block, minRatio) {
    return block.charsBefore >= TAIL_MIN_CHARS && block.ratio >= minRatio;
  }

  function getTailCandidateRejectionReason(blocks, candidate) {
    if (candidate.block.charsBefore < TAIL_MIN_CHARS) {
      return "too-few-main-text-chars";
    }

    if (candidate.reason !== "end-marker" && hasPostCutoffBodyContinuation(blocks, candidate.block.index)) {
      return "body-like-content-after-candidate";
    }

    return "";
  }

  function hasLowConfidenceTailSupport(blocks, startIndex) {
    const supportBlocks = blocks.slice(startIndex + 1, startIndex + 7);
    const supportCount = supportBlocks.filter((block) => {
      return (
        getHighConfidenceTailReason(block) ||
        getMediumConfidenceTailReason(block) ||
        block.hasContactSignal ||
        block.hasQrSignal ||
        TAIL_LOW_PATTERNS.some((pattern) => pattern.test(block.text))
      );
    }).length;

    return supportCount >= 2;
  }

  function hasPostCutoffBodyContinuation(blocks, cutoffIndex) {
    return blocks
      .slice(cutoffIndex + 1, cutoffIndex + 9)
      .some((block) => isLikelyMainBodyBlock(block));
  }

  function isLikelyMainBodyBlock(block) {
    if (block.length < POST_CUTOFF_LONG_BLOCK_LENGTH) {
      return false;
    }

    if (
      getHighConfidenceTailReason(block) ||
      getMediumConfidenceTailReason(block) ||
      block.hasUrl ||
      block.linkDensity > 0.32
    ) {
      return false;
    }

    if (/^\s*(?:\[\d+\]|［\d+］|\d+[.、])/.test(block.text)) {
      return false;
    }

    const hanCount = (block.text.match(/\p{Script=Han}/gu) || []).length;
    return hanCount >= 50;
  }

  function isEndMarkerText(text) {
    return END_MARKERS.has(normalizeTailMarker(text));
  }

  function isReferenceMarkerText(text) {
    const marker = normalizeTailMarker(text);
    return REFERENCE_MARKERS.has(marker);
  }

  function normalizeTailMarker(text) {
    return String(text || "")
      .replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "")
      .toUpperCase();
  }

  function getReadableLength(text) {
    return String(text || "").replace(/\s/g, "").length;
  }

  function getElementDepth(element, root) {
    let depth = 0;
    let current = element;
    while (current && current !== root) {
      depth += 1;
      current = current.parentElement;
    }

    return depth;
  }

  function isNodeBeforeReadCutoff(node, cutoffElement) {
    if (!cutoffElement) {
      return true;
    }

    if (node === cutoffElement || cutoffElement.contains(node)) {
      return false;
    }

    if (node.nodeType === Node.ELEMENT_NODE && node.contains(cutoffElement)) {
      return true;
    }

    return Boolean(node.compareDocumentPosition(cutoffElement) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function processNode(node, collector, options = {}) {
    if (!isNodeBeforeReadCutoff(node, options.cutoffElement)) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      wrapTextNode(node, collector);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node;
    if (shouldSkipElement(element)) {
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      processNode(child, collector, options);
    }

    if (BOUNDARY_TAGS.has(element.tagName)) {
      collector.finishSentence();
    }
  }

  function wrapTextNode(textNode, collector) {
    const text = textNode.nodeValue || "";
    if (!READABLE_RE.test(text)) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let buffer = "";

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      buffer += char;

      if (!TERMINATORS.has(char)) {
        continue;
      }

      while (index + 1 < text.length && CLOSERS.has(text[index + 1])) {
        index += 1;
        buffer += text[index];
      }

      appendSegment(fragment, buffer, collector);
      buffer = "";
      collector.finishSentence();
    }

    if (buffer) {
      appendSegment(fragment, buffer, collector);
    }

    textNode.replaceWith(fragment);
  }

  function appendSegment(fragment, text, collector) {
    if (!text) {
      return;
    }

    if (!READABLE_RE.test(text)) {
      fragment.append(document.createTextNode(text));
      return;
    }

    const span = document.createElement("span");
    span.className = "wechat-tts-sentence";
    span.dataset.wechatTtsSentenceId = String(collector.getCurrentId());
    span.textContent = text;
    fragment.append(span);
    collector.appendText(text);
  }

  function shouldSkipElement(element) {
    if (EXCLUDED_TAGS.has(element.tagName)) {
      return true;
    }

    if (element.closest(WECHAT_PAGE_METADATA_SELECTOR)) {
      return true;
    }

    if (element.dataset.wechatTtsSelectionAnchor === "true") {
      return true;
    }

    if (
      element.classList.contains("mp_profile_iframe_wrp") ||
      element.classList.contains("js_uneditable") ||
      element.classList.contains("rich_pages") ||
      element.closest("[aria-hidden='true']")
    ) {
      return true;
    }

    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  }

  function isSkippableTextNode(textNode, root) {
    let element = textNode.parentElement;
    while (element) {
      if (element === selectionToolbar) {
        return true;
      }

      if (element === root) {
        return false;
      }

      if (shouldSkipElement(element)) {
        return true;
      }

      element = element.parentElement;
    }

    return true;
  }

  function removeExistingMarkup(root) {
    removeSentenceMarkup(root);
    clearHighlight();
  }

  function removeSentenceMarkup(root) {
    for (const span of root.querySelectorAll("span.wechat-tts-sentence")) {
      span.replaceWith(...Array.from(span.childNodes));
    }
    root.normalize?.();
  }

  function highlightSentence(id, index, total) {
    clearHighlight();

    const root = readerState.root || findArticleRoot();
    if (!root) {
      return { ok: false, error: "没有找到正文区域" };
    }

    const spans = root.querySelectorAll(`[data-wechat-tts-sentence-id="${String(id)}"]`);
    if (spans.length === 0) {
      return { ok: false, error: "没有找到当前句子" };
    }

    const sentenceRange = createRangeFromElements(spans);
    if (sentenceRange && setCurrentRangeHighlight(sentenceRange)) {
      markCurrentSentenceSpans(spans);
      setReadingFocusTarget(spans, sentenceRange);
      scrollRangeIntoView(sentenceRange);
      document.documentElement.dataset.wechatTtsProgress = `${Number(index) + 1}/${Number(total)}`;
      return { ok: true };
    }

    for (const span of spans) {
      span.classList.add("wechat-tts-current-sentence");
      span.dataset.wechatTtsActive = "true";
    }
    setReadingFocusTarget(spans, sentenceRange);

    const first = spans[0];
    first.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest"
    });

    document.documentElement.dataset.wechatTtsProgress = `${Number(index) + 1}/${Number(total)}`;

    return { ok: true };
  }

  function clearHighlight() {
    for (const element of document.querySelectorAll(".wechat-tts-current-sentence, [data-wechat-tts-active]")) {
      element.classList.remove("wechat-tts-current-sentence");
      delete element.dataset.wechatTtsActive;
    }

    if (window.CSS?.highlights) {
      CSS.highlights.delete("wechat-tts-current-sentence");
    }

    hideReadingFocusFrame();
    clearReadingFocusTarget();
    delete document.documentElement.dataset.wechatTtsProgress;
    return { ok: true };
  }

  function markCurrentSentenceSpans(spans) {
    const orderedSpans = Array.from(spans);
    for (const span of orderedSpans) {
      span.dataset.wechatTtsActive = "true";
    }
  }

  function setCurrentRangeHighlight(range) {
    if (window.CSS?.highlights && typeof Highlight === "function") {
      CSS.highlights.set("wechat-tts-current-sentence", new Highlight(range));
      return true;
    }

    return false;
  }

  function createRangeFromElements(elements) {
    const orderedElements = Array.from(elements).filter((element) => element.textContent);
    if (orderedElements.length === 0) {
      return null;
    }

    const range = document.createRange();
    const first = orderedElements[0];
    const last = orderedElements[orderedElements.length - 1];
    const firstTextNode = getFirstTextNode(first);
    const lastTextNode = getLastTextNode(last);

    if (firstTextNode && lastTextNode) {
      range.setStart(firstTextNode, 0);
      range.setEnd(lastTextNode, lastTextNode.nodeValue.length);
      return range;
    }

    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    return range;
  }

  function getFirstTextNode(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue) {
        return node;
      }

      node = walker.nextNode();
    }

    return null;
  }

  function getLastTextNode(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lastNode = null;
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue) {
        lastNode = node;
      }

      node = walker.nextNode();
    }

    return lastNode;
  }

  function scrollRangeIntoView(range) {
    const rect = range.getBoundingClientRect();
    if (rect && rect.height > 0) {
      const targetY = rect.top + window.scrollY - window.innerHeight / 2 + rect.height / 2;
      window.scrollTo({
        top: Math.max(0, targetY),
        behavior: "smooth"
      });
      return;
    }

    const element = range.startContainer.parentElement;
    element?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest"
    });
  }

  function showReadingFocusFrameForSentence(elements, sentenceRange = null) {
    showReadingFocusFrame(getReadingFocusRectForSentence(elements, sentenceRange));
  }

  function setReadingFocusTarget(elements, sentenceRange = null) {
    readingFocusTarget = {
      elements: Array.from(elements),
      range: sentenceRange
    };
    refreshReadingFocusFrame();
  }

  function clearReadingFocusTarget() {
    readingFocusTarget = null;
    if (readingFocusUpdateFrame !== null) {
      window.cancelAnimationFrame(readingFocusUpdateFrame);
      readingFocusUpdateFrame = null;
    }
  }

  function scheduleReadingFocusFrameUpdate() {
    if (!readingFocusTarget || readingFocusUpdateFrame !== null) {
      return;
    }

    readingFocusUpdateFrame = window.requestAnimationFrame(() => {
      readingFocusUpdateFrame = null;
      refreshReadingFocusFrame();
    });
  }

  function refreshReadingFocusFrame() {
    if (!readingFocusTarget) {
      hideReadingFocusFrame();
      return;
    }

    const elements = readingFocusTarget.elements.filter((element) => element.isConnected);
    if (elements.length === 0) {
      clearReadingFocusTarget();
      hideReadingFocusFrame();
      return;
    }

    showReadingFocusFrameForSentence(elements, readingFocusTarget.range);
  }

  function getReadingFocusRectForSentence(elements, sentenceRange = null) {
    const elementRects = getVisibleElementRects(elements);
    const rangeRects = sentenceRange ? getVisibleRangeRects(sentenceRange) : [];
    const verticalRects = rangeRects.length > 0 ? rangeRects : elementRects;
    if (verticalRects.length === 0) {
      return null;
    }

    const lines = groupRectsByVisualLine(verticalRects);
    if (lines.length === 0) {
      return null;
    }

    const firstLine = lines[0];
    const bounds = getRectBounds(lines);
    const lineStartLeft = getSentenceLineStartLeft(elements, firstLine);
    const left = Math.min(firstLine.left, lineStartLeft ?? firstLine.left);
    const right = Math.max(bounds.right, firstLine.right);

    return {
      left,
      top: bounds.top,
      width: Math.max(1, right - left),
      height: bounds.bottom - bounds.top
    };
  }

  function getVisibleElementRects(elements) {
    return sortRectsByVisualPosition(
      Array.from(elements)
        .flatMap((element) => Array.from(element.getClientRects()))
        .filter((rect) => rect.width > 0 && rect.height > 0)
    );
  }

  function getVisibleRangeRects(range) {
    return sortRectsByVisualPosition(
      Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
    );
  }

  function sortRectsByVisualPosition(rects) {
    return Array.from(rects).sort((first, second) => {
      const topCompare = Math.round(first.top) - Math.round(second.top);
      return topCompare || Math.round(first.left) - Math.round(second.left);
    });
  }

  function groupRectsByVisualLine(rects) {
    const lines = [];

    for (const rect of sortRectsByVisualPosition(rects)) {
      const line = lines.find((candidate) => rectVerticallyOverlapsLine(rect, candidate));
      if (!line) {
        lines.push(createRectBounds(rect));
        continue;
      }

      expandRectBounds(line, rect);
    }

    return sortRectsByVisualPosition(lines);
  }

  function getRectBounds(rects) {
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));

    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  }

  function createRectBounds(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function expandRectBounds(bounds, rect) {
    bounds.left = Math.min(bounds.left, rect.left);
    bounds.top = Math.min(bounds.top, rect.top);
    bounds.right = Math.max(bounds.right, rect.right);
    bounds.bottom = Math.max(bounds.bottom, rect.bottom);
    bounds.width = bounds.right - bounds.left;
    bounds.height = bounds.bottom - bounds.top;
  }

  function getSentenceLineStartLeft(elements, firstLine) {
    const root = readerState.root || findArticleRoot();
    const firstElement = Array.from(elements).find((element) => element.textContent);
    if (!root || !firstElement || !root.contains(firstElement)) {
      return firstLine.left;
    }

    const boundary = findSentenceBoundaryElement(firstElement, root);
    if (!boundary || !boundary.contains(firstElement)) {
      return firstLine.left;
    }

    return (
      getBoundaryContentLineStartLeft(boundary, firstLine) ??
      firstLine.left
    );
  }

  function getBoundaryContentLineStartLeft(boundary, lineRect) {
    const boundaryRange = document.createRange();
    try {
      boundaryRange.selectNodeContents(boundary);

      const sameLineRects = getVisibleRangeRects(boundaryRange).filter((rect) =>
        rectVerticallyOverlapsLine(rect, lineRect)
      );

      if (sameLineRects.length === 0) {
        return null;
      }

      return Math.min(...sameLineRects.map((rect) => rect.left));
    } catch (_error) {
      return null;
    } finally {
      boundaryRange.detach?.();
    }
  }

  function rectVerticallyOverlapsLine(rect, lineRect) {
    const overlap = Math.min(rect.bottom, lineRect.bottom) - Math.max(rect.top, lineRect.top);
    const referenceHeight = Math.min(rect.height, lineRect.height);
    return overlap > referenceHeight * 0.45;
  }

  function showReadingFocusFrame(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      hideReadingFocusFrame();
      return;
    }

    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      hideReadingFocusFrame();
      return;
    }

    const frame = ensureReadingFocusFrame();
    const insetX = 8;
    const insetY = 5;
    const left = Math.max(4, rect.left - insetX);
    const top = Math.max(4, rect.top - insetY);

    frame.style.left = `${Math.round(left)}px`;
    frame.style.top = `${Math.round(top)}px`;
    frame.style.width = "3px";
    frame.style.height = `${Math.round(rect.height + insetY * 2)}px`;
    frame.hidden = false;
  }

  function ensureReadingFocusFrame() {
    const existingFrames = Array.from(document.querySelectorAll(".wechat-tts-focus-frame"));
    if (readingFocusFrame && !readingFocusFrame.isConnected) {
      readingFocusFrame = null;
    }

    if (!readingFocusFrame && existingFrames.length > 0) {
      readingFocusFrame = existingFrames[0];
    }

    for (const frame of existingFrames) {
      if (frame !== readingFocusFrame) {
        frame.remove();
      }
    }

    if (!readingFocusFrame) {
      readingFocusFrame = document.createElement("div");
      readingFocusFrame.className = "wechat-tts-focus-frame";
      readingFocusFrame.dataset.wechatTtsVersion = CONTENT_SCRIPT_VERSION;
      readingFocusFrame.hidden = true;
      (document.body || document.documentElement).append(readingFocusFrame);
    } else {
      readingFocusFrame.dataset.wechatTtsVersion = CONTENT_SCRIPT_VERSION;
    }

    return readingFocusFrame;
  }

  function hideReadingFocusFrame() {
    const frames = Array.from(document.querySelectorAll(".wechat-tts-focus-frame"));
    if (!readingFocusFrame && frames.length > 0) {
      readingFocusFrame = frames[0];
    }

    for (const frame of frames) {
      frame.hidden = true;
      if (readingFocusFrame && frame !== readingFocusFrame) {
        frame.remove();
      }
    }

    if (readingFocusFrame && !readingFocusFrame.isConnected) {
      readingFocusFrame = null;
    }
  }

  function buildPreparedResponse() {
    return {
      ok: true,
      title: getArticleTitle(),
      articleKey: getArticleProgressKey(),
      total: readerState.sentences.length,
      sentences: readerState.sentences
    };
  }

  function getArticleProgressKey() {
    try {
      const url = new URL(window.location.href);
      const biz = url.searchParams.get("__biz");
      const mid = url.searchParams.get("mid");
      const idx = url.searchParams.get("idx");
      const sn = url.searchParams.get("sn");

      if (biz && mid && idx) {
        return `${url.origin}${url.pathname}?__biz=${biz}&mid=${mid}&idx=${idx}&sn=${sn || ""}`;
      }

      if (isWechatShortArticlePath(url.pathname)) {
        return `${url.origin}${normalizeArticlePathname(url.pathname)}`;
      }

      return getNormalizedArticleUrlKey(url);
    } catch (_) {
      return window.location.href.split("#")[0];
    }
  }

  function isWechatShortArticlePath(pathname) {
    return /^\/s\/[^/]+\/?$/.test(String(pathname || ""));
  }

  function normalizeArticlePathname(pathname) {
    const cleanPathname = String(pathname || "/");
    return cleanPathname !== "/" ? cleanPathname.replace(/\/+$/, "") : cleanPathname;
  }

  function getNormalizedArticleUrlKey(url) {
    const pathname = normalizeArticlePathname(url.pathname);
    const sortedParams = Array.from(url.searchParams.entries()).sort((first, second) => {
      const keyCompare = first[0].localeCompare(second[0]);
      return keyCompare || first[1].localeCompare(second[1]);
    });
    const search = new URLSearchParams(sortedParams).toString();
    return `${url.origin}${pathname}${search ? `?${search}` : ""}`;
  }

  function getArticleTitle() {
    const titleSelectors = [
      "#activity-name",
      "#js_text_title",
      "#js_video_page_title",
      "#js_audio_title",
      "meta[property='og:title']",
      "meta[property='twitter:title']",
      "meta[name='twitter:title']"
    ];

    for (const selector of titleSelectors) {
      const element = document.querySelector(selector);
      const title = normalizeUtterance(element?.getAttribute("content") || element?.textContent || "");
      if (title) {
        return title;
      }
    }

    return normalizeUtterance(document.title || "微信公众号文章");
  }

  function normalizeUtterance(text) {
    return String(text)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();
  }

  function isReadableSentence(text) {
    if (!READABLE_RE.test(text)) {
      return false;
    }

    const compact = text.replace(/\s/g, "");
    return compact.length >= 2;
  }

  function getSelectionInfo() {
    if (!selectionToolbar) {
      return null;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const text = normalizeUtterance(selection.toString());
    if (!isReadableSentence(text)) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const root = findArticleRoot();
    if (!root || !isRangeInsideRoot(range, root)) {
      return null;
    }

    const rect = getUsefulRangeRect(range);
    if (!rect) {
      return null;
    }

    return { range, rect, text };
  }

  function isRangeInsideRoot(range, root) {
    return isNodeInsideRoot(range.startContainer, root) && isNodeInsideRoot(range.endContainer, root);
  }

  function isNodeInsideRoot(node, root) {
    if (!node) {
      return false;
    }

    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element && root.contains(element));
  }

  function findSentenceBoundaryElement(node, root) {
    let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;

    while (element && element !== root.parentElement) {
      if (BOUNDARY_TAGS.has(element.tagName)) {
        return element;
      }

      if (element === root) {
        break;
      }

      element = element.parentElement;
    }

    return root;
  }

  function getUsefulRangeRect(range) {
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );

    return rects[rects.length - 1] || null;
  }

  function showSelectionToolbar(rect) {
    const toolbarRect = selectionToolbar.getBoundingClientRect();
    const width = Math.min(toolbarRect.width || 214, Math.max(1, window.innerWidth - 16));
    const height = toolbarRect.height || 44;
    const left = Math.min(
      window.innerWidth - width - 8,
      Math.max(8, rect.left + rect.width / 2 - width / 2)
    );
    const top = rect.top - height - 10 > 8 ? rect.top - height - 10 : rect.bottom + 10;

    selectionToolbar.style.left = `${Math.round(left)}px`;
    const clampedTop = Math.max(8, Math.min(window.innerHeight - height - 8, top));

    selectionToolbar.style.top = `${Math.round(clampedTop)}px`;
    selectionToolbar.hidden = false;
  }

  function hideSelectionToolbar() {
    if (selectionToolbar) {
      selectionToolbar.hidden = true;
    }
  }

  function clearNativeSelection() {
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }
  }

  function areRangesEqual(first, second) {
    return (
      first.startContainer === second.startContainer &&
      first.startOffset === second.startOffset &&
      first.endContainer === second.endContainer &&
      first.endOffset === second.endOffset
    );
  }

  async function handleFloatingPlayerAction(action) {
    const previousState = floatingPlayerState;
    if (floatingPlayerState?.status === "starting") {
      return;
    }

    if (action === "toggle" && (!floatingPlayerState || ["ready", "idle", "completed", "error", "busy"].includes(floatingPlayerState.status))) {
      await startPreparedArticleFromFloatingPlayer(floatingPlayerState?.status === "busy");
      return;
    }

    const typeByAction = {
      previous: MESSAGE.PREVIOUS,
      toggle: MESSAGE.TOGGLE_PAUSE,
      next: MESSAGE.NEXT,
      stop: MESSAGE.STOP
    };
    const type = typeByAction[action];
    if (!type) {
      return;
    }

    const response = await sendRuntimeMessage({ type });
    if (response?.ok) {
      if (shouldRecoverPausedArticleFromIdle(action, previousState, response)) {
        await recoverPausedArticleFromIdle(previousState);
        return;
      }

      renderFloatingPlayer(response);
    }
  }

  function shouldRecoverPausedArticleFromIdle(action, previousState, response) {
    return (
      action === "toggle" &&
      response?.status === "idle" &&
      previousState?.status === "paused" &&
      previousState.source === "article" &&
      Boolean(previousState.articleKey) &&
      Number(previousState.total) > 0 &&
      Number(previousState.index) > 0
    );
  }

  async function recoverPausedArticleFromIdle(previousState) {
    const total = Math.max(0, Math.round(Number(previousState.total) || 0));
    const currentIndex = Math.min(total, Math.max(1, Math.round(Number(previousState.index) || 1)));

    floatingReadyStartIndex = currentIndex - 1;
    floatingReadyStartIndexExplicit = true;
    await saveArticleProgress(previousState.articleKey, floatingReadyStartIndex, total, previousState.title || "");
    await startPreparedArticleFromFloatingPlayer(false);
  }

  async function startPreparedArticleFromFloatingPlayer(takeover = false) {
    const prepared = prepareArticle();
    if (!prepared.ok || prepared.sentences.length === 0) {
      renderFloatingPlayer({
        ok: true,
        status: "error",
        rate: floatingPlayerState?.rate || DEFAULT_RATE,
        index: 0,
        total: 0,
        title: "公众号文章",
        source: "article",
        sentenceText: "",
        error: prepared.error || "没有识别到可朗读的句子"
      });
      return;
    }

    let startIndex = floatingReadyStartIndex;
    if (!floatingReadyStartIndexExplicit) {
      const storedProgress = await loadArticleProgress(prepared.articleKey, prepared.sentences.length, prepared.title);
      startIndex = storedProgress ? storedProgress.index : 0;
    }

    const response = await sendRuntimeMessage({
      type: MESSAGE.START_PREPARED,
      title: prepared.title,
      sentences: prepared.sentences,
      articleKey: prepared.articleKey,
      rate: getFloatingRateValue(),
      startIndex,
      takeover,
      explicitStartIndex: floatingReadyStartIndexExplicit
    });

    if (response?.ok) {
      floatingReadyStartIndex = 0;
      floatingReadyStartIndexExplicit = false;
      renderFloatingPlayer(response);
    }
  }

  function renderFloatingPlayer(state) {
    if (!floatingPlayer || !state?.ok) {
      return;
    }

    floatingPlayerState = state;
    if (!["ready", "error"].includes(state.status)) {
      floatingReadyStartIndexExplicit = false;
    }
    floatingPlayer.dataset.wechatTtsStatus = state.status || "idle";

    const shouldShow = state.status !== "idle" && (Number(state.total) > 0 || ["busy", "error"].includes(state.status));
    floatingPlayer.hidden = !shouldShow;
    document.body.classList.toggle("has-wechat-tts-floating-player", shouldShow);

    if (!shouldShow) {
      return;
    }

    updateFloatingPlayerBounds();

    const title = state.status === "busy"
      ? (state.activeTitle ? `正在朗读：${state.activeTitle}` : "另一标签页正在朗读")
      : state.title || "公众号文章";
    const statusLabel = getFloatingStatusLabel(state);

    floatingPlayer.querySelector(".wechat-tts-floating-kicker").textContent =
      state.status === "busy" ? "其他标签" : "公众号边听边读";
    floatingPlayer.querySelector(".wechat-tts-floating-title").textContent = title;
    floatingPlayer.querySelector(".wechat-tts-floating-progress").textContent =
      `${state.index || 0} / ${state.total || 0}`;
    floatingPlayer.querySelector(".wechat-tts-floating-state").textContent = statusLabel;
    if (!floatingProgressEditing && document.activeElement !== getFloatingProgressInput()) {
      updateFloatingProgressControl(state.index || 0, state.total || 0);
    }
    if (state.status === "starting") {
      const progressInput = getFloatingProgressInput();
      if (progressInput) {
        progressInput.disabled = true;
      }
    }

    const toggleButton = floatingPlayer.querySelector("[data-wechat-tts-player-action='toggle']");
    toggleButton.textContent = getFloatingToggleLabel(state);
    toggleButton.disabled = !["ready", "playing", "paused", "completed", "error", "busy"].includes(state.status);

    const canNavigate = ["playing", "paused", "completed"].includes(state.status);
    floatingPlayer.querySelector("[data-wechat-tts-player-action='previous']").disabled = !canNavigate;
    floatingPlayer.querySelector("[data-wechat-tts-player-action='next']").disabled = !canNavigate;

    if (!floatingRateEditing && document.activeElement !== getFloatingRateInput()) {
      updateFloatingRateControl(state.rate || DEFAULT_RATE);
    }

    if (document.activeElement !== getSelectionRateInput()) {
      updateSelectionRateControl(state.rate || DEFAULT_RATE);
    }
  }

  function getFloatingStatusLabel(state) {
    if (state.error) {
      return state.error;
    }

    switch (state.status) {
      case "playing":
        return "正在播放";
      case "starting":
        return "正在启动";
      case "paused":
        return "已暂停";
      case "ready":
        return Number(state.index) > 0 ? "准备续播" : "准备播放";
      case "completed":
        return "播放完成";
      case "error":
        return "播放出错";
      case "busy":
        return "另一标签页正在朗读";
      default:
        return "准备就绪";
    }
  }

  function getFloatingToggleLabel(state) {
    switch (state.status) {
      case "playing":
        return "暂停";
      case "starting":
        return "正在启动";
      case "paused":
        return "继续";
      case "busy":
        return "接管";
      default:
        return "开始";
    }
  }

  function getFloatingRateInput() {
    return floatingPlayer?.querySelector(".wechat-tts-floating-rate select") || null;
  }

  function getFloatingProgressInput() {
    return floatingPlayer?.querySelector(".wechat-tts-floating-progressbar input") || null;
  }

  function getSelectionRateInput() {
    return selectionToolbar?.querySelector(".wechat-tts-selection-rate select") || null;
  }

  async function commitFloatingRate() {
    if (floatingRateCommitTimer) {
      window.clearTimeout(floatingRateCommitTimer);
      floatingRateCommitTimer = null;
    }

    const rate = getFloatingRateValue();
    const previousState = floatingPlayerState;
    const response = await sendRuntimeMessage({
      type: MESSAGE.SET_RATE,
      rate
    });

    floatingRateEditing = false;
    if (previousState && ["ready", "error"].includes(previousState.status) && Number(previousState.total) > 0) {
      renderFloatingPlayer({
        ...previousState,
        rate
      });
      return;
    }

    if (response?.ok) {
      renderFloatingPlayer(response);
    }
  }

  function updateFloatingRateControl(rate) {
    const normalized = normalizeRate(rate);
    const input = getFloatingRateInput();

    if (input) {
      input.value = String(normalized);
    }
  }

  function updateSelectionRateControl(rate) {
    const normalized = normalizeRate(rate);
    const input = getSelectionRateInput();

    if (input) {
      input.value = String(normalized);
    }
  }

  function getFloatingRateValue() {
    return normalizeRate(getFloatingRateInput()?.value);
  }

  function getSelectionRateValue() {
    return normalizeRate(getSelectionRateInput()?.value);
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

  function getProgressPercent(state) {
    const index = Number(state.index) || 0;
    const total = Number(state.total) || 0;
    if (total <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, (index / total) * 100));
  }

  function updateFloatingProgressControl(index, total) {
    const input = getFloatingProgressInput();
    if (!input) {
      return;
    }

    const safeTotal = Math.max(0, Math.round(Number(total) || 0));
    const safeIndex = Math.min(safeTotal, Math.max(0, Math.round(Number(index) || 0)));
    input.min = "0";
    input.max = String(safeTotal);
    input.value = String(safeIndex);
    input.disabled = safeTotal <= 0;
    input.style.setProperty("--wechat-tts-progress", `${safeTotal > 0 ? (safeIndex / safeTotal) * 100 : 0}%`);
  }

  function handleFloatingProgressInput() {
    const input = getFloatingProgressInput();
    if (!input || !floatingProgressEditing) {
      return;
    }

    floatingProgressEditing = true;
    const total = Number(input.max) || 0;
    const index = Math.min(total, Math.max(0, Math.round(Number(input.value) || 0)));
    input.value = String(index);
    input.style.setProperty("--wechat-tts-progress", `${total > 0 ? (index / total) * 100 : 0}%`);
    floatingPlayer.querySelector(".wechat-tts-floating-progress").textContent = `${index} / ${total}`;
  }

  async function commitFloatingProgressSeek() {
    const input = getFloatingProgressInput();
    if (!input) {
      return;
    }

    const total = Number(input.max) || 0;
    const rawIndex = Math.min(total, Math.max(0, Math.round(Number(input.value) || 0)));
    const targetIndex = Math.max(1, rawIndex);
    floatingProgressEditing = false;

    if (total <= 0) {
      updateFloatingProgressControl(0, 0);
      return;
    }

    if (floatingPlayerState?.status === "starting") {
      renderFloatingPlayer(floatingPlayerState);
      return;
    }

    if (!floatingPlayerState || ["ready", "idle", "error"].includes(floatingPlayerState.status)) {
      floatingReadyStartIndex = targetIndex - 1;
      floatingReadyStartIndexExplicit = true;
      await saveArticleProgress(
        floatingPlayerState?.articleKey,
        floatingReadyStartIndex,
        total,
        floatingPlayerState?.title || ""
      );
      const nextState = {
        ...(floatingPlayerState || {}),
        ok: true,
        status: floatingPlayerState?.status || "ready",
        index: targetIndex,
        total
      };
      renderFloatingPlayer(nextState);
      return;
    }

    const response = await sendRuntimeMessage({
      type: MESSAGE.SEEK,
      index: targetIndex
    });

    if (response?.ok) {
      renderFloatingPlayer(response);
    }
  }

  async function loadArticleProgress(articleKey, total, title = "") {
    if (!articleKey || total <= 0) {
      return null;
    }

    const storageKey = getProgressStorageKey(articleKey);
    const stored = await getLocalStorageSafely(storageKey);
    const progress = stored[storageKey];
    if (!isStoredProgressForArticle(progress, articleKey, total, title)) {
      return null;
    }

    const index = Number(progress.index);
    if (!Number.isFinite(index)) {
      return null;
    }

    return {
      index: Math.min(total - 1, Math.max(0, Math.round(index))),
      title: String(progress.title || ""),
      updatedAt: Number(progress.updatedAt) || 0
    };
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

  async function saveArticleProgress(articleKey, index, total, title) {
    if (!articleKey || total <= 0) {
      return;
    }

    const safeIndex = Math.min(total - 1, Math.max(0, Math.round(Number(index) || 0)));
    await setLocalStorageSafely({
      [getProgressStorageKey(articleKey)]: {
        articleKey,
        index: safeIndex,
        total,
        title,
        updatedAt: Date.now()
      }
    }).catch(() => {});
  }

  function installPageLifecycleProgressSaver() {
    window.addEventListener("pagehide", saveCurrentArticleProgressOnPageLifecycle);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        saveCurrentArticleProgressOnPageLifecycle();
      }
    });
  }

  function saveCurrentArticleProgressOnPageLifecycle() {
    const state = floatingPlayerState;
    if (
      !state ||
      state.source !== "article" ||
      !state.articleKey ||
      !["ready", "playing", "paused"].includes(state.status)
    ) {
      return;
    }

    const total = Math.max(0, Math.round(Number(state.total) || 0));
    if (total <= 0) {
      return;
    }

    const currentIndex = Math.round(Number(state.index) || 0);
    const storageIndex = Math.min(total - 1, Math.max(0, currentIndex - 1));
    void saveArticleProgress(state.articleKey, storageIndex, total, state.title || "");
  }

  function getProgressStorageKey(articleKey) {
    return `${PROGRESS_STORAGE_PREFIX}${articleKey}`;
  }

  function scheduleFloatingPlayerBoundsUpdate() {
    if (floatingBoundsTimer) {
      window.clearTimeout(floatingBoundsTimer);
    }

    floatingBoundsTimer = window.setTimeout(updateFloatingPlayerBounds, 80);
  }

  function updateFloatingPlayerBounds() {
    if (!floatingPlayer || floatingPlayer.hidden) {
      return;
    }

    if (window.matchMedia("(max-width: 720px)").matches) {
      floatingPlayer.style.removeProperty("--wechat-tts-player-left");
      floatingPlayer.style.removeProperty("--wechat-tts-player-width");
      return;
    }

    const article = findArticleRoot();
    const target = findArticleWidthTarget(article);
    if (!target) {
      floatingPlayer.style.removeProperty("--wechat-tts-player-left");
      floatingPlayer.style.removeProperty("--wechat-tts-player-width");
      return;
    }

    const rect = target.getBoundingClientRect();
    const minWidth = 360;
    const maxWidth = window.innerWidth - 32;
    if (rect.width < minWidth) {
      floatingPlayer.style.removeProperty("--wechat-tts-player-left");
      floatingPlayer.style.removeProperty("--wechat-tts-player-width");
      return;
    }

    const width = Math.min(rect.width, maxWidth);
    const left = Math.min(
      window.innerWidth - width - 16,
      Math.max(16, rect.left)
    );

    floatingPlayer.style.setProperty("--wechat-tts-player-left", `${Math.round(left)}px`);
    floatingPlayer.style.setProperty("--wechat-tts-player-width", `${Math.round(width)}px`);
  }

  function findArticleWidthTarget(article) {
    if (!article) {
      return null;
    }

    const candidates = [
      article,
      document.querySelector("#js_article"),
      document.querySelector(".rich_media_area_primary"),
      document.querySelector(".rich_media_content")
    ].filter(Boolean);

    return candidates
      .map((element) => ({
        element,
        rect: element.getBoundingClientRect()
      }))
      .filter(({ rect }) => rect.width > 0 && rect.left >= 0)
      .sort((a, b) => a.rect.width - b.rect.width)[0]?.element || article;
  }

  function handleDocumentKeydown(event) {
    const isSpace = event.code === "Space" || event.key === " ";
    if (!isSpace || event.defaultPrevented || shouldIgnoreSpaceShortcut(event.target)) {
      return;
    }

    if (!floatingPlayerState || !["ready", "playing", "paused", "busy"].includes(floatingPlayerState.status)) {
      return;
    }

    event.preventDefault();
    runAsyncSafely(() => handleFloatingPlayerAction("toggle"));
  }

  function shouldIgnoreSpaceShortcut(target) {
    if (!target || target === document.body || target === document.documentElement) {
      return false;
    }

    if (target.isContentEditable) {
      return true;
    }

    return Boolean(target.closest(
      "input, textarea, select, button, audio, video, [contenteditable='true'], .wechat-tts-selection-toolbar"
    ));
  }

  async function requestFloatingPlayerState() {
    const response = await sendRuntimeMessage({ type: MESSAGE.GET_STATE });
    if (response?.ok) {
      renderFloatingPlayer(response);
    }
    return response;
  }

  function sendRuntimeMessage(message) {
    try {
      if (!chrome.runtime?.id) {
        return Promise.resolve(null);
      }

      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function getLocalStorageSafely(key) {
    try {
      if (!chrome.storage?.local) {
        return Promise.resolve({});
      }

      return chrome.storage.local.get(key).catch(() => ({}));
    } catch (_error) {
      return Promise.resolve({});
    }
  }

  function setLocalStorageSafely(values) {
    try {
      if (!chrome.storage?.local) {
        return Promise.resolve();
      }

      return chrome.storage.local.set(values).catch(() => {});
    } catch (_error) {
      return Promise.resolve();
    }
  }

  function runAsyncSafely(callback) {
    try {
      Promise.resolve(callback()).catch(() => {});
    } catch (_error) {
      // Old content scripts can keep event handlers after extension reload.
    }
  }
})();
