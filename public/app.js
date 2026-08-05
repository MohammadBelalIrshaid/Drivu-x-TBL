(() => {
  "use strict";

  const MIN_CHOICES = 2;
  const MAX_CHOICES = 16;
  const DEFAULT_CHOICES = 6;
  const MAX_LOCAL_HISTORY = 20;
  const TAU = Math.PI * 2;
  const SETTINGS_KEY = "drivuRoulette.settings.v1";
  const HISTORY_KEY = "drivuRoulette.history.v1";
  const ROUND_STATE_KEY = "drivuRoulette.round.v1";
  const WHEEL_COLORS = ["#c8b9d0", "#38a2c8", "#123f8e"];
  const INK = "#15365f";

  const state = {
    choices: [],
    showLabels: true,
    rotation: 0,
    isSpinning: false,
    eligibilityReady: false,
    canSpin: false,
    generation: null,
    previousSpin: null,
    eligibilitySource: "unknown",
    ownerBusy: false,
    resetBusy: false,
    ownerAuthenticated: false,
    reducedMotion: false,
    canvasWidth: 0,
    canvasHeight: 0,
    dpr: 1,
    redrawFrame: 0,
    winnerReturnFocus: null,
    resetReturnFocus: null,
  };

  const elements = {};
  let choiceIdCounter = 0;

  const first = (...selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  };

  const byId = (id) => document.getElementById(id);

  const clamp = (value, minimum, maximum) =>
    Math.min(maximum, Math.max(minimum, value));

  const normalizeAngle = (angle) => ((angle % TAU) + TAU) % TAU;

  function createChoiceId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `choice-${window.crypto.randomUUID()}`;
    }

    choiceIdCounter += 1;
    let randomPart = "";
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const random = new Uint32Array(1);
      window.crypto.getRandomValues(random);
      randomPart = random[0].toString(36);
    } else {
      randomPart = Math.floor(Math.random() * 0xffffffff).toString(36);
    }
    return `choice-${Date.now().toString(36)}-${choiceIdCounter}-${randomPart}`;
  }

  function safeRead(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function safeWrite(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function readRoundState() {
    const saved = safeRead(ROUND_STATE_KEY, null);
    return {
      generation:
        saved?.generation === null || saved?.generation === undefined
          ? null
          : String(saved.generation),
      attempted: saved?.attempted === true,
      previousSpin:
        saved?.previousSpin && typeof saved.previousSpin === "object"
          ? saved.previousSpin
          : null,
    };
  }

  function writeRoundState(roundState) {
    safeWrite(ROUND_STATE_KEY, {
      generation:
        roundState.generation === null || roundState.generation === undefined
          ? null
          : String(roundState.generation),
      attempted: roundState.attempted === true,
      previousSpin: roundState.previousSpin || null,
    });
  }

  function clearLocalHistory() {
    try {
      window.localStorage.removeItem(HISTORY_KEY);
    } catch (_error) {
      // The in-memory UI can still be refreshed when storage is unavailable.
    }
    renderLocalHistory();
  }

  function reconcileGeneration(generation) {
    const nextGeneration =
      generation === null || generation === undefined ? null : String(generation);
    const savedRound = readRoundState();
    if (savedRound.generation !== nextGeneration) {
      const carryUnknownAttempt =
        savedRound.generation === null &&
        (savedRound.attempted || readLocalHistory().length > 0);
      if (!carryUnknownAttempt) clearLocalHistory();
      const freshRound = {
        generation: nextGeneration,
        attempted: carryUnknownAttempt,
        previousSpin: carryUnknownAttempt ? savedRound.previousSpin : null,
      };
      writeRoundState(freshRound);
      state.generation = nextGeneration;
      return freshRound;
    }
    state.generation = nextGeneration;
    return savedRound;
  }

  function serializeSpinForRound(spin) {
    if (!spin || typeof spin !== "object") return null;
    return {
      id: spin.id || createChoiceId(),
      createdAt: spin.createdAt || new Date().toISOString(),
      winnerIndex: Number.isInteger(Number(spin.winnerIndex))
        ? Number(spin.winnerIndex)
        : null,
      participant:
        typeof spin.participant === "string" ? spin.participant.slice(0, 120) : "",
      result: {
        id: spin.result?.id || "",
        label:
          typeof spin.result?.label === "string" && spin.result.label.trim()
            ? spin.result.label.trim()
            : "Prize",
      },
      source: spin.source || "server",
    };
  }

  function markRoundAttempt(spin) {
    const serialized = serializeSpinForRound(spin);
    state.previousSpin = serialized;
    writeRoundState({
      generation: state.generation,
      attempted: true,
      previousSpin: serialized,
    });
  }

  function resolvedLabel(choice, index) {
    const label = typeof choice?.label === "string" ? choice.label.trim() : "";
    return label || `Prize ${index + 1}`;
  }

  function resolvedChoices() {
    return state.choices.map((choice, index) => ({
      id: choice.id,
      label: resolvedLabel(choice, index),
    }));
  }

  function restoreSettings() {
    const saved = safeRead(SETTINGS_KEY, null);
    const savedChoices = Array.isArray(saved?.choices) ? saved.choices : [];
    const requestedCount = clamp(
      Number.parseInt(saved?.count ?? savedChoices.length ?? DEFAULT_CHOICES, 10) ||
        DEFAULT_CHOICES,
      MIN_CHOICES,
      MAX_CHOICES,
    );
    const seenIds = new Set();

    state.choices = Array.from({ length: requestedCount }, (_unused, index) => {
      const savedChoice = savedChoices[index];
      const rawLabel =
        typeof savedChoice === "string"
          ? savedChoice
          : typeof savedChoice?.label === "string"
            ? savedChoice.label
            : "";
      let id = typeof savedChoice?.id === "string" ? savedChoice.id.trim() : "";
      if (!id || seenIds.has(id)) id = createChoiceId();
      seenIds.add(id);
      return { id, label: rawLabel };
    });

    state.showLabels = saved?.showLabels !== false;
  }

  function persistSettings() {
    safeWrite(SETTINGS_KEY, {
      count: state.choices.length,
      showLabels: state.showLabels,
      choices: state.choices.map(({ id, label }) => ({ id, label })),
    });
  }

  function captureElements() {
    elements.canvas = byId("wheelCanvas");
    elements.spinButton = byId("spinButton");
    elements.participantInput = byId("participantInput");
    elements.choiceCount = byId("choiceCount");
    elements.choiceFields = byId("choiceFields");
    elements.showLabels = byId("showLabels");
    elements.addChoice = first(
      "#addChoiceButton",
      "#addChoice",
      "[data-action='add-choice']",
    );
    elements.removeChoice = first(
      "#removeChoiceButton",
      "#removeChoice",
      "[data-action='remove-choice']",
    );
    elements.resultPanel = first(
      "#resultPanel",
      "#resultBanner",
      "[data-result-panel]",
    );
    elements.resultLabel = first(
      "#liveResult",
      "#resultLabel",
      "#winnerLabel",
      "#resultText",
      "[data-result-label]",
    );
    elements.resultMeta = first(
      "#resultMeta",
      "#winnerMeta",
      "[data-result-meta]",
    );
    elements.spinStatus = first(
      "#spinStatus",
      "#statusMessage",
      "#spinHelp",
      "[data-spin-status]",
    );
    elements.spinHelp = byId("spinHelp");
    elements.localHistory = byId("localHistoryList") || byId("localHistory");
    elements.localHistoryEmpty = first(
      "#localHistoryEmpty",
      "[data-local-history-empty]",
    );
    elements.clearHistory = first(
      "#clearHistoryButton",
      "[data-action='clear-history']",
    );
    elements.connectionStatus = first(
      "#apiStatus",
      "#connectionStatus",
      "[data-api-status]",
    );

    elements.winnerDialog = byId("winnerDialog");
    elements.winnerPrize = byId("winnerPrize");
    elements.winnerMessage = byId("winnerMessage");
    elements.winnerPrivacy = byId("winnerPrivacyNote");
    elements.winnerClose = first(
      "#winnerCloseButton",
      "#winnerDialogCloseButton",
      ".winner-done-button",
      "[data-winner-close]",
    );

    elements.ownerDialog = byId("ownerDialog");
    elements.ownerOpen = first(
      "#ownerAccessButton",
      "#ownerOpenButton",
      "#openOwnerDialog",
      "[data-owner-open]",
    );
    elements.ownerClose = first(
      "#ownerCloseButton",
      "#closeOwnerDialog",
      "[data-owner-close]",
    );
    elements.ownerDashboardClose = byId("ownerDashboardCloseButton");
    elements.ownerPin = byId("ownerPin");
    elements.ownerLoginButton = byId("ownerLoginButton");
    elements.ownerLogoutButton = first(
      "#ownerLogoutButton",
      "[data-owner-logout]",
    );
    elements.ownerLoginView = first(
      "#ownerLoginView",
      "#ownerLoginPanel",
      "[data-owner-login-view]",
    );
    elements.ownerDashboard = first(
      "#ownerDashboardView",
      "#ownerDashboard",
      "#ownerResults",
      "[data-owner-dashboard]",
    );
    elements.ownerLoginError = byId("ownerLoginError");
    elements.ownerStatus = first(
      "#ownerStatus",
      "#ownerMessage",
      "[data-owner-status]",
    );
    elements.ownerResultsBody = byId("ownerResultsBody");
    elements.ownerTotal = first(
      "#ownerTotalSpins",
      "[data-owner-total]",
    );
    elements.ownerParticipants = first(
      "#ownerUniqueParticipants",
      "[data-owner-participants]",
    );
    elements.ownerToday = byId("ownerTodaySpins");
    elements.ownerTopPrize = first(
      "#ownerTopResult",
      "#ownerTopPrize",
      "[data-owner-top-prize]",
    );
    elements.ownerResultsCount = byId("ownerResultsCount");
    elements.ownerResetButton = byId("ownerResetButton");
    elements.ownerStats = first("#ownerStats", "[data-owner-stats]");
    elements.ownerExport = first(
      "#ownerExportLink",
      "[data-owner-export]",
    );

    elements.resetDialog = byId("resetDialog");
    elements.resetConfirm = first(
      "#resetConfirmButton",
      "#ownerResetConfirmButton",
      "[data-reset-confirm]",
    );
    elements.resetCancel = first(
      "#resetCancelButton",
      "#ownerResetCancelButton",
      "[data-reset-cancel]",
    );
    elements.resetClose = first(
      "#resetCloseButton",
      "#resetDialogCloseButton",
      "[data-reset-close]",
    );
    elements.resetStatus = first(
      "#resetStatus",
      "#resetError",
      "[data-reset-status]",
    );
  }

  function installTestIds() {
    const testIds = [
      [elements.canvas, "roulette-wheel"],
      [elements.spinButton, "spin-button"],
      [elements.choiceFields, "choice-fields"],
      [elements.localHistory, "local-history-list"],
      [elements.winnerDialog, "winner-dialog"],
      [elements.ownerDialog, "owner-dialog"],
      [elements.ownerResultsBody, "owner-results"],
      [elements.resetDialog, "reset-dialog"],
    ];
    for (const [element, testId] of testIds) {
      if (element && !element.dataset.testid) element.dataset.testid = testId;
    }
  }

  function playControlsLocked() {
    return state.isSpinning || (state.eligibilityReady && !state.canSpin);
  }

  function setSpinButtonCopy(primary, secondary) {
    if (!elements.spinButton) return;
    const primaryNode = elements.spinButton.querySelector(":scope > span");
    const secondaryNode = elements.spinButton.querySelector(":scope > small");
    if (primaryNode) primaryNode.textContent = primary;
    if (secondaryNode) secondaryNode.textContent = secondary;
    if (!primaryNode && !secondaryNode) {
      elements.spinButton.textContent = `${primary} ${secondary}`.trim();
    }
  }

  function updatePlayControls() {
    const locked = playControlsLocked();
    const spinDisabled = state.isSpinning || !state.eligibilityReady || !state.canSpin;
    if (elements.spinButton) {
      elements.spinButton.disabled = spinDisabled;
      elements.spinButton.setAttribute("aria-busy", String(state.isSpinning));
      elements.spinButton.dataset.state = state.isSpinning
        ? "spinning"
        : !state.eligibilityReady
          ? "checking"
          : state.canSpin
            ? "ready"
            : "played";
    }

    if (!state.eligibilityReady) {
      setSpinButtonCopy("Checking", "your turn");
      setSpinStatus("Checking whether this browser has already played\u2026", "neutral");
    } else if (state.isSpinning) {
      setSpinButtonCopy("Spinning", "good luck");
    } else if (!state.canSpin) {
      setSpinButtonCopy("Already", "played");
      const previousLabel = state.previousSpin?.result?.label;
      setSpinStatus(
        previousLabel
          ? `Already played \u2014 your prize was ${previousLabel}.`
          : "Already played \u2014 one spin is allowed per round.",
        "warning",
      );
    } else {
      setSpinButtonCopy("Spin", "to win");
      setSpinStatus("One tap starts the wheel. One spin per campaign round.", "neutral");
    }

    [elements.participantInput, elements.choiceCount, elements.showLabels].forEach(
      (control) => {
        if (control) control.disabled = locked;
      },
    );
    elements.choiceFields?.querySelectorAll("input, button").forEach((control) => {
      control.disabled = locked;
    });
    syncChoiceCount();
  }

  function syncChoiceCount() {
    if (!elements.choiceCount) return;
    if (
      elements.choiceCount instanceof HTMLInputElement ||
      elements.choiceCount instanceof HTMLSelectElement
    ) {
      elements.choiceCount.value = String(state.choices.length);
      elements.choiceCount.min = String(MIN_CHOICES);
      elements.choiceCount.max = String(MAX_CHOICES);
    } else {
      elements.choiceCount.textContent = String(state.choices.length);
    }
    elements.choiceCount.setAttribute(
      "aria-label",
      `${state.choices.length} prize choices`,
    );

    if (elements.addChoice) {
      elements.addChoice.disabled =
        playControlsLocked() || state.choices.length >= MAX_CHOICES;
    }
    if (elements.removeChoice) {
      elements.removeChoice.disabled =
        playControlsLocked() || state.choices.length <= MIN_CHOICES;
    }
  }

  function renderChoiceFields(focusIndex = -1) {
    if (!elements.choiceFields) {
      syncChoiceCount();
      return;
    }

    const fragment = document.createDocumentFragment();
    state.choices.forEach((choice, index) => {
      const row = document.createElement("div");
      row.className = "choice-row";
      row.dataset.choiceId = choice.id;

      const swatch = document.createElement("span");
      swatch.className = "choice-swatch";
      swatch.style.backgroundColor = WHEEL_COLORS[index % WHEEL_COLORS.length];
      swatch.setAttribute("aria-hidden", "true");

      const label = document.createElement("label");
      const inputId = `choice-label-${choice.id}`;
      label.className = "sr-only";
      label.htmlFor = inputId;
      label.textContent = `Prize ${index + 1} label (optional)`;

      const input = document.createElement("input");
      input.id = inputId;
      input.type = "text";
      input.name = "choiceLabel";
      input.value = choice.label;
      input.placeholder = `Prize ${index + 1}`;
      input.maxLength = 60;
      input.autocomplete = "off";
      input.dataset.choiceIndex = String(index);
      input.dataset.testid = `choice-input-${index}`;
      input.setAttribute("aria-label", `Prize ${index + 1} label (optional)`);
      input.disabled = playControlsLocked();

      const number = document.createElement("span");
      number.className = "choice-number";
      number.setAttribute("aria-hidden", "true");
      number.textContent = String(index + 1).padStart(2, "0");

      row.append(swatch, label, input, number);
      fragment.append(row);
    });

    elements.choiceFields.replaceChildren(fragment);
    syncChoiceCount();

    if (focusIndex >= 0) {
      const input = elements.choiceFields.querySelector(
        `[data-choice-index="${focusIndex}"]`,
      );
      input?.focus();
    }
  }

  function setChoiceCount(requestedCount, focusNewChoice = false) {
    if (playControlsLocked()) return;
    const nextCount = clamp(
      Number.parseInt(requestedCount, 10) || MIN_CHOICES,
      MIN_CHOICES,
      MAX_CHOICES,
    );
    const oldCount = state.choices.length;
    if (nextCount === oldCount) {
      syncChoiceCount();
      return;
    }

    if (nextCount > oldCount) {
      while (state.choices.length < nextCount) {
        state.choices.push({ id: createChoiceId(), label: "" });
      }
    } else {
      state.choices.length = nextCount;
    }

    renderChoiceFields(focusNewChoice && nextCount > oldCount ? nextCount - 1 : -1);
    persistSettings();
    scheduleWheelDraw();
  }

  function removeChoiceAt(index) {
    if (
      playControlsLocked() ||
      state.choices.length <= MIN_CHOICES ||
      index < 0 ||
      index >= state.choices.length
    ) {
      return;
    }
    state.choices.splice(index, 1);
    renderChoiceFields(Math.min(index, state.choices.length - 1));
    persistSettings();
    scheduleWheelDraw();
  }

  function resizeCanvas() {
    if (!elements.canvas) return;
    const rect = elements.canvas.getBoundingClientRect();
    const fallbackWidth = elements.canvas.parentElement?.clientWidth || 520;
    const width = Math.max(240, Math.round(rect.width || fallbackWidth));
    const height = Math.max(240, Math.round(rect.height || width));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);

    state.canvasWidth = width;
    state.canvasHeight = height;
    state.dpr = dpr;

    const physicalWidth = Math.round(width * dpr);
    const physicalHeight = Math.round(height * dpr);
    if (
      elements.canvas.width !== physicalWidth ||
      elements.canvas.height !== physicalHeight
    ) {
      elements.canvas.width = physicalWidth;
      elements.canvas.height = physicalHeight;
    }
    drawWheel();
  }

  function scheduleWheelDraw() {
    if (state.redrawFrame) return;
    state.redrawFrame = window.requestAnimationFrame(() => {
      state.redrawFrame = 0;
      drawWheel();
    });
  }

  function shortenedText(context, text, maximumWidth) {
    if (context.measureText(text).width <= maximumWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = `${text.slice(0, middle)}\u2026`;
      if (context.measureText(candidate).width <= maximumWidth) low = middle;
      else high = middle - 1;
    }
    return `${text.slice(0, Math.max(1, low))}\u2026`;
  }

  function drawWheel() {
    const canvas = elements.canvas;
    if (!canvas || !state.canvasWidth || !state.canvasHeight) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const width = state.canvasWidth;
    const height = state.canvasHeight;
    const minimumDimension = Math.min(width, height);
    const centerX = width / 2;
    const centerY = height / 2 + minimumDimension * 0.012;
    const radius = Math.max(96, minimumDimension / 2 - minimumDimension * 0.065);
    const choices = resolvedChoices();
    const sectorAngle = TAU / choices.length;
    const sectorStart = -Math.PI / 2 - sectorAngle / 2;

    context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    context.save();
    context.shadowColor = "rgba(15, 46, 88, 0.22)";
    context.shadowBlur = minimumDimension * 0.035;
    context.shadowOffsetY = minimumDimension * 0.018;
    context.beginPath();
    context.arc(centerX, centerY, radius + 8, 0, TAU);
    context.fillStyle = "#f8f5ed";
    context.fill();
    context.restore();

    choices.forEach((choice, index) => {
      const start = sectorStart + state.rotation + index * sectorAngle;
      const end = start + sectorAngle;
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.arc(centerX, centerY, radius, start, end);
      context.closePath();
      context.fillStyle = WHEEL_COLORS[index % WHEEL_COLORS.length];
      context.fill();
      context.strokeStyle = "rgba(255, 255, 255, 0.96)";
      context.lineWidth = Math.max(3, minimumDimension * 0.009);
      context.lineJoin = "round";
      context.stroke();

      if (!state.showLabels) return;
      const centerAngle = start + sectorAngle / 2;
      const fontSize = clamp(
        radius * (choices.length <= 6 ? 0.075 : choices.length <= 10 ? 0.058 : 0.043),
        10,
        24,
      );
      context.save();
      context.translate(centerX, centerY);
      context.rotate(centerAngle);
      context.translate(radius * 0.62, 0);
      const normalizedCenter = normalizeAngle(centerAngle);
      context.rotate(
        Math.PI / 2 +
          (normalizedCenter > 0 && normalizedCenter < Math.PI ? Math.PI : 0),
      );
      context.font = `700 ${fontSize}px Arial, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = index % WHEEL_COLORS.length === 2 ? "#ffffff" : INK;
      context.shadowColor =
        index % WHEEL_COLORS.length === 2
          ? "rgba(5, 34, 79, 0.35)"
          : "rgba(255, 255, 255, 0.35)";
      context.shadowBlur = 2;
      const maximumWidth = radius * (choices.length <= 8 ? 0.58 : 0.48);
      context.fillText(shortenedText(context, choice.label, maximumWidth), 0, 0);
      context.restore();
    });

    context.beginPath();
    context.arc(centerX, centerY, radius + 5, 0, TAU);
    context.strokeStyle = "#ffffff";
    context.lineWidth = Math.max(5, minimumDimension * 0.013);
    context.stroke();
    context.beginPath();
    context.arc(centerX, centerY, radius + 9, 0, TAU);
    context.strokeStyle = INK;
    context.lineWidth = Math.max(2, minimumDimension * 0.005);
    context.stroke();

    const hubRadius = clamp(minimumDimension * 0.025, 8, 15);
    context.beginPath();
    context.arc(centerX, centerY, hubRadius, 0, TAU);
    context.fillStyle = "#fffdf7";
    context.fill();
    context.strokeStyle = INK;
    context.lineWidth = 3;
    context.stroke();

    canvas.setAttribute(
      "aria-label",
      `Prize wheel with ${choices.length} choices: ${choices
        .map((choice) => choice.label)
        .join(", ")}`,
    );
  }

  function secureRandomIndex(length) {
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const range = 0x100000000;
      const ceiling = Math.floor(range / length) * length;
      const random = new Uint32Array(1);
      do {
        window.crypto.getRandomValues(random);
      } while (random[0] >= ceiling);
      return random[0] % length;
    }
    return Math.floor(Math.random() * length);
  }

  function localFallbackAvailable() {
    const round = readRoundState();
    return !round.attempted && readLocalHistory().length === 0;
  }

  async function fetchJson(url, options = {}, timeout = 7000) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await window.fetch(url, {
        credentials: "same-origin",
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      let data = null;
      try {
        data = await response.json();
      } catch (_error) {
        data = null;
      }
      if (!response.ok) {
        const error = new Error(
          data?.error?.message || data?.message || `Request failed (${response.status})`,
        );
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function chooseWinner(choices, participant) {
    try {
      const response = await fetchJson("/api/spin", {
        method: "POST",
        body: JSON.stringify({
          choices,
          ...(participant ? { participant } : {}),
        }),
      });
      const winnerIndex = Number(response?.winnerIndex);
      if (!Number.isInteger(winnerIndex) || winnerIndex < 0 || winnerIndex >= choices.length) {
        throw new Error("The server returned an invalid prize index.");
      }
      return {
        kind: "spin",
        id: response.id || createChoiceId(),
        createdAt: response.createdAt || new Date().toISOString(),
        winnerIndex,
        participant,
        result: {
          id: response.result?.id || choices[winnerIndex].id,
          label: response.result?.label || choices[winnerIndex].label,
        },
        source: "server",
      };
    } catch (error) {
      if (
        error?.status === 409 &&
        error?.data?.error?.code === "already_spun"
      ) {
        return {
          kind: "locked",
          previousSpin: error?.data?.previousSpin || state.previousSpin || null,
          message:
            error?.data?.error?.message ||
            error?.message ||
            "This browser has already played this round.",
          code: error?.data?.error?.code || "request_rejected",
        };
      }

      if (error?.status >= 400 && error.status < 500) {
        return {
          kind: "error",
          message:
            error?.data?.error?.message ||
            error?.message ||
            "The spin could not be started. Please try again.",
          code: error?.data?.error?.code || "request_rejected",
        };
      }

      if (!localFallbackAvailable()) {
        return {
          kind: "locked",
          previousSpin: state.previousSpin || readRoundState().previousSpin,
          message: "This browser has already used its local attempt for this round.",
          code: "local_attempt_used",
        };
      }

      const winnerIndex = secureRandomIndex(choices.length);
      return {
        kind: "spin",
        id: createChoiceId(),
        createdAt: new Date().toISOString(),
        winnerIndex,
        participant,
        result: choices[winnerIndex],
        source: "local",
        fallbackReason: error?.message || "The server could not be reached.",
      };
    }
  }

  function easeOutQuint(value) {
    return 1 - Math.pow(1 - value, 5);
  }

  function animateToWinner(winnerIndex) {
    const sectorAngle = TAU / state.choices.length;
    const desiredRotation = normalizeAngle(-winnerIndex * sectorAngle);
    const currentRotation = normalizeAngle(state.rotation);

    if (state.reducedMotion) {
      state.rotation = desiredRotation;
      drawWheel();
      return Promise.resolve();
    }

    const forwardAlignment = normalizeAngle(desiredRotation - currentRotation);
    const extraTurns = 6 + secureRandomIndex(3);
    const startRotation = state.rotation;
    const targetRotation =
      startRotation + extraTurns * TAU + forwardAlignment;
    const duration = 4200 + secureRandomIndex(801);

    return new Promise((resolve) => {
      const startedAt = performance.now();
      const frame = (now) => {
        const progress = clamp((now - startedAt) / duration, 0, 1);
        state.rotation =
          startRotation + (targetRotation - startRotation) * easeOutQuint(progress);
        drawWheel();
        if (progress < 1) {
          window.requestAnimationFrame(frame);
        } else {
          state.rotation = desiredRotation;
          drawWheel();
          resolve();
        }
      };
      window.requestAnimationFrame(frame);
    });
  }

  function setSpinStatus(message, tone = "neutral") {
    const targets = new Set([elements.spinStatus, elements.spinHelp].filter(Boolean));
    targets.forEach((target) => {
      target.textContent = message;
      target.dataset.tone = tone;
    });
  }

  function setSpinning(isSpinning) {
    state.isSpinning = isSpinning;
    updatePlayControls();
  }

  function readLocalHistory() {
    const history = safeRead(HISTORY_KEY, []);
    return Array.isArray(history) ? history.slice(0, MAX_LOCAL_HISTORY) : [];
  }

  function saveLocalResult(outcome, participant) {
    const history = readLocalHistory().filter((entry) => entry.id !== outcome.id);
    history.unshift({
      id: outcome.id,
      createdAt: outcome.createdAt,
      participant: participant || "",
      winnerIndex: outcome.winnerIndex,
      resultLabel: outcome.result.label,
      source: outcome.source,
    });
    safeWrite(HISTORY_KEY, history.slice(0, MAX_LOCAL_HISTORY));
    renderLocalHistory();
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Just now";
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
    } catch (_error) {
      return date.toLocaleString();
    }
  }

  function renderLocalHistory() {
    if (!elements.localHistory) return;
    const history = readLocalHistory();
    const isTableBody = elements.localHistory.tagName === "TBODY";
    const fragment = document.createDocumentFragment();

    history.forEach((entry, index) => {
      if (isTableBody) {
        const row = document.createElement("tr");
        const resultCell = document.createElement("td");
        const participantCell = document.createElement("td");
        const timeCell = document.createElement("td");
        resultCell.textContent = entry.resultLabel || "Prize";
        participantCell.textContent = entry.participant || "Guest";
        timeCell.textContent = formatDate(entry.createdAt);
        row.append(resultCell, participantCell, timeCell);
        fragment.append(row);
        return;
      }

      const item = document.createElement(
        elements.localHistory.matches("ul, ol") ? "li" : "article",
      );
      item.className = "history-item";

      const marker = document.createElement("span");
      marker.className = "history-item__number";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = String(index + 1).padStart(2, "0");

      const copy = document.createElement("span");
      copy.className = "history-copy";
      const result = document.createElement("strong");
      result.textContent = entry.resultLabel || "Prize";
      const details = document.createElement("small");
      const participant = entry.participant ? `${entry.participant} \u00b7 ` : "";
      const localOnly = entry.source === "local" ? " \u00b7 local only" : "";
      details.textContent = `${participant}${formatDate(entry.createdAt)}${localOnly}`;
      copy.append(result, details);
      item.append(marker, copy);
      fragment.append(item);
    });

    elements.localHistory.replaceChildren(fragment);
    if (elements.localHistoryEmpty) {
      elements.localHistoryEmpty.hidden = history.length > 0;
    }
    if (elements.clearHistory) {
      elements.clearHistory.hidden = history.length === 0;
    }
  }

  function presentResult(outcome, participant) {
    const label = outcome.result.label;
    if (elements.resultLabel) elements.resultLabel.textContent = label;
    if (elements.resultMeta) {
      const subject = participant ? `${participant}, you landed on` : "You landed on";
      elements.resultMeta.textContent = `${subject} ${label}.`;
    }
    if (elements.resultPanel) {
      elements.resultPanel.hidden = false;
      elements.resultPanel.dataset.visible = "true";
      elements.resultPanel.classList.remove("is-celebrating");
      void elements.resultPanel.offsetWidth;
      elements.resultPanel.classList.add("is-celebrating");
    }
    const saveMessage =
      outcome.source === "server"
        ? "Result recorded."
        : "Offline result saved on this device only.";
    setSpinStatus(`${label}! ${saveMessage}`, outcome.source === "server" ? "success" : "warning");
  }

  function normalizePreviousSpin(previousSpin) {
    if (!previousSpin || typeof previousSpin !== "object") return null;
    const label =
      typeof previousSpin.result?.label === "string"
        ? previousSpin.result.label.trim()
        : typeof previousSpin.resultLabel === "string"
          ? previousSpin.resultLabel.trim()
          : "";
    if (!label) return null;
    const winnerIndex = Number(previousSpin.winnerIndex);
    return {
      kind: "spin",
      id: previousSpin.id || createChoiceId(),
      createdAt: previousSpin.createdAt || new Date().toISOString(),
      winnerIndex: Number.isInteger(winnerIndex) ? winnerIndex : null,
      participant:
        typeof previousSpin.participant === "string" ? previousSpin.participant : "",
      result: {
        id: previousSpin.result?.id || "",
        label,
      },
      source: previousSpin.source || "server",
    };
  }

  function closeWinnerDialog(event) {
    event?.preventDefault();
    if (!elements.winnerDialog) return;
    if (typeof elements.winnerDialog.close === "function" && elements.winnerDialog.open) {
      elements.winnerDialog.close();
    } else {
      elements.winnerDialog.hidden = true;
      elements.winnerDialog.removeAttribute("open");
    }
    const returnTarget = state.winnerReturnFocus;
    state.winnerReturnFocus = null;
    if (returnTarget && !returnTarget.disabled && returnTarget.isConnected) {
      returnTarget.focus();
    } else {
      elements.ownerOpen?.focus();
    }
  }

  function openWinnerDialog(outcome, participant, { alreadyPlayed = false } = {}) {
    if (!outcome) return;
    if (elements.winnerPrize) elements.winnerPrize.textContent = outcome.result.label;
    if (elements.winnerMessage) {
      if (alreadyPlayed) {
        elements.winnerMessage.textContent =
          "You have already played this round. This was your prize.";
      } else if (outcome.source === "local") {
        elements.winnerMessage.textContent = participant
          ? `${participant}, this device-only result is your one spin for this round.`
          : "This device-only result is your one spin for this round.";
      } else {
        elements.winnerMessage.textContent = participant
          ? `${participant}, your prize has been recorded for this round.`
          : "Your prize has been recorded for this round.";
      }
    }
    if (elements.winnerPrivacy) {
      elements.winnerPrivacy.textContent =
        outcome.source === "local"
          ? "This fallback result is saved on this device only."
          : "This result has been saved. The owner can review it privately.";
    }
    if (!elements.winnerDialog) return;
    state.winnerReturnFocus = document.activeElement;
    if (typeof elements.winnerDialog.showModal === "function") {
      if (!elements.winnerDialog.open) elements.winnerDialog.showModal();
    } else {
      elements.winnerDialog.hidden = false;
      elements.winnerDialog.setAttribute("open", "");
    }
    window.setTimeout(() => elements.winnerClose?.focus(), 0);
  }

  function lockRound(previousSpin, { openDialog = false, message = "" } = {}) {
    const normalized = normalizePreviousSpin(previousSpin);
    state.eligibilityReady = true;
    state.canSpin = false;
    state.previousSpin = normalized;

    if (normalized) {
      markRoundAttempt(normalized);
      saveLocalResult(normalized, normalized.participant);
      if (
        Number.isInteger(normalized.winnerIndex) &&
        normalized.winnerIndex >= 0 &&
        normalized.winnerIndex < state.choices.length
      ) {
        state.rotation = normalizeAngle(
          -normalized.winnerIndex * (TAU / state.choices.length),
        );
        drawWheel();
      }
      if (elements.resultLabel) elements.resultLabel.textContent = normalized.result.label;
    } else {
      writeRoundState({
        generation: state.generation,
        attempted: true,
        previousSpin: null,
      });
    }

    updatePlayControls();
    if (message && !normalized) setSpinStatus(message, "warning");
    if (openDialog && normalized) {
      openWinnerDialog(normalized, normalized.participant, { alreadyPlayed: true });
    }
  }

  function launchConfetti() {
    if (state.reducedMotion || typeof Element.prototype.animate !== "function") return;
    let layer = first("#confettiLayer", "[data-confetti-layer]");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "confettiLayer";
      layer.dataset.confettiLayer = "";
      layer.dataset.testid = "confetti-layer";
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, {
        position: "fixed",
        inset: "0",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: "9999",
      });
      document.body.append(layer);
    }

    const originX = window.innerWidth / 2;
    const originY = Math.min(window.innerHeight * 0.42, 390);
    const colors = [...WHEEL_COLORS, "#ffffff", "#f4c85c"];
    for (let index = 0; index < 32; index += 1) {
      const piece = document.createElement("i");
      const width = 5 + secureRandomIndex(6);
      const height = 8 + secureRandomIndex(8);
      Object.assign(piece.style, {
        position: "absolute",
        left: `${originX}px`,
        top: `${originY}px`,
        width: `${width}px`,
        height: `${height}px`,
        borderRadius: secureRandomIndex(2) ? "50%" : "2px",
        background: colors[secureRandomIndex(colors.length)],
        willChange: "transform, opacity",
      });
      layer.append(piece);
      const horizontal = secureRandomIndex(321) - 160;
      const vertical = 180 + secureRandomIndex(260);
      const rotation = secureRandomIndex(721) - 360;
      const delay = secureRandomIndex(180);
      const animation = piece.animate(
        [
          { transform: "translate(-50%, -50%) scale(.8) rotate(0deg)", opacity: 0 },
          { transform: `translate(${horizontal * 0.18}px, -${vertical * 0.3}px) scale(1) rotate(${rotation * 0.25}deg)`, opacity: 1, offset: 0.18 },
          { transform: `translate(${horizontal}px, ${vertical}px) scale(.9) rotate(${rotation}deg)`, opacity: 0 },
        ],
        {
          duration: 1350 + secureRandomIndex(650),
          delay,
          easing: "cubic-bezier(.18,.7,.3,1)",
          fill: "forwards",
        },
      );
      animation.finished
        .catch(() => {})
        .finally(() => piece.remove());
    }
  }

  async function handleSpin() {
    if (
      state.isSpinning ||
      !state.eligibilityReady ||
      !state.canSpin ||
      state.choices.length < MIN_CHOICES
    ) {
      return;
    }
    const choices = resolvedChoices();
    const participant = elements.participantInput?.value.trim().slice(0, 120) || "";
    setSpinning(true);
    if (state.eligibilitySource === "server") {
      const stillEligible = await checkEligibility();
      if (!stillEligible) {
        setSpinning(false);
        return;
      }
    }
    if (elements.resultPanel) {
      elements.resultPanel.classList.remove("is-celebrating");
      elements.resultPanel.dataset.visible = "false";
    }
    setSpinStatus("Selecting your prize\u2026", "neutral");

    let finalStatus = null;
    try {
      const outcome = await chooseWinner(choices, participant);
      if (outcome.kind === "locked") {
        lockRound(outcome.previousSpin, {
          openDialog: true,
          message: outcome.message,
        });
        return;
      }
      if (outcome.kind === "error") {
        if (outcome.code === "visitor_cookie_required") {
          await checkEligibility();
        }
        finalStatus = {
          message: outcome.message,
          tone: "error",
        };
        return;
      }

      state.canSpin = false;
      state.previousSpin = serializeSpinForRound(outcome);
      markRoundAttempt(outcome);
      updatePlayControls();
      if (outcome.source === "local") {
        setConnectionStatus(false, "Local result \u00b7 one attempt used");
        setSpinStatus("Connection unavailable. Spinning locally\u2026", "warning");
      } else {
        setSpinStatus("Prize selected. Here we go\u2026", "neutral");
      }
      await animateToWinner(outcome.winnerIndex);
      saveLocalResult(outcome, participant);
      presentResult(outcome, participant);
      openWinnerDialog(outcome, participant);
      launchConfetti();
    } catch (_error) {
      finalStatus = {
        message: "Something interrupted the spin. Please try again.",
        tone: "error",
      };
    } finally {
      setSpinning(false);
      if (finalStatus) setSpinStatus(finalStatus.message, finalStatus.tone);
    }
  }

  function setConnectionStatus(isOnline, message) {
    if (!elements.connectionStatus) return;
    elements.connectionStatus.textContent = message;
    elements.connectionStatus.dataset.state = isOnline ? "online" : "offline";
  }

  async function checkHealth() {
    try {
      const response = await fetchJson("/api/health", {}, 4000);
      if (!response?.ok) throw new Error("Service unavailable");
      setConnectionStatus(true, "Secure recording online");
      return true;
    } catch (_error) {
      setConnectionStatus(false, "Local mode available");
      return false;
    }
  }

  function resetVisibleResult() {
    if (elements.resultLabel) {
      elements.resultLabel.textContent = "Waiting for the first spin";
    }
    if (elements.resultMeta) elements.resultMeta.textContent = "";
    if (elements.resultPanel) {
      elements.resultPanel.hidden = true;
      elements.resultPanel.dataset.visible = "false";
      elements.resultPanel.classList.remove("is-celebrating");
    }
  }

  async function checkEligibility() {
    state.eligibilityReady = false;
    state.canSpin = false;
    updatePlayControls();

    try {
      const response = await fetchJson("/api/eligibility", {}, 5000);
      if (
        typeof response?.eligible !== "boolean" ||
        !Object.prototype.hasOwnProperty.call(response, "generation")
      ) {
        throw new Error("Eligibility response was incomplete.");
      }

      const nextGeneration =
        response.generation === null || response.generation === undefined
          ? null
          : String(response.generation);
      const generationChanged = readRoundState().generation !== nextGeneration;
      const round = reconcileGeneration(response.generation);
      if (generationChanged) resetVisibleResult();

      const history = readLocalHistory();
      const previous =
        normalizePreviousSpin(response.previousSpin) ||
        normalizePreviousSpin(round.previousSpin) ||
        normalizePreviousSpin(history[0]);
      const locallyUsed = round.attempted || history.length > 0;

      state.eligibilitySource = "server";
      state.eligibilityReady = true;
      setConnectionStatus(true, "Secure recording online");
      if (response.eligible && !locallyUsed) {
        state.canSpin = true;
        state.previousSpin = null;
        updatePlayControls();
      } else {
        lockRound(previous, { openDialog: false });
      }
      return state.canSpin;
    } catch (_error) {
      const round = readRoundState();
      const history = readLocalHistory();
      const previous =
        normalizePreviousSpin(round.previousSpin) ||
        normalizePreviousSpin(history[0]);
      const locallyUsed = round.attempted || history.length > 0;

      state.generation = round.generation;
      state.eligibilitySource = "local";
      state.eligibilityReady = true;
      setConnectionStatus(false, "Local mode available");
      if (locallyUsed) {
        lockRound(previous, { openDialog: false });
      } else {
        state.canSpin = true;
        state.previousSpin = null;
        updatePlayControls();
      }
      return state.canSpin;
    }
  }

  function setOwnerStatus(message, tone = "neutral") {
    if (elements.ownerStatus) {
      elements.ownerStatus.textContent = message;
      elements.ownerStatus.dataset.tone = tone;
    }
    if (elements.ownerLoginError) {
      const showAsError = tone === "error" || tone === "warning";
      elements.ownerLoginError.textContent = message;
      elements.ownerLoginError.hidden = !showAsError;
    }
  }

  function setOwnerAuthenticated(authenticated) {
    state.ownerAuthenticated = authenticated;
    elements.ownerDialog?.classList.toggle("is-authenticated", authenticated);
    if (elements.ownerLoginView) elements.ownerLoginView.hidden = authenticated;
    if (elements.ownerDashboard) elements.ownerDashboard.hidden = !authenticated;
    if (!elements.ownerLoginView) {
      if (elements.ownerPin) elements.ownerPin.hidden = authenticated;
      if (elements.ownerLoginButton) elements.ownerLoginButton.hidden = authenticated;
    }
    if (elements.ownerLogoutButton) elements.ownerLogoutButton.hidden = !authenticated;
    if (elements.ownerResetButton) elements.ownerResetButton.hidden = !authenticated;
    if (elements.ownerExport) elements.ownerExport.hidden = !authenticated;
  }

  function setOwnerBusy(isBusy) {
    state.ownerBusy = isBusy;
    [elements.ownerPin, elements.ownerLoginButton, elements.ownerLogoutButton].forEach(
      (element) => {
        if (element) element.disabled = isBusy;
      },
    );
    if (elements.ownerLoginButton) {
      elements.ownerLoginButton.setAttribute("aria-busy", String(isBusy));
    }
  }

  function renderOwnerSpins(payload) {
    const spins = Array.isArray(payload?.spins) ? payload.spins : [];
    const total = Number.isFinite(Number(payload?.count)) ? Number(payload.count) : spins.length;
    const participants = new Set(
      spins
        .map((spin) => (typeof spin.participant === "string" ? spin.participant.trim() : ""))
        .filter(Boolean)
        .map((participant) => participant.toLocaleLowerCase()),
    );
    const prizeCounts = new Map();
    spins.forEach((spin) => {
      const label = spin?.result?.label || `Prize ${(Number(spin?.winnerIndex) || 0) + 1}`;
      prizeCounts.set(label, (prizeCounts.get(label) || 0) + 1);
    });
    const topPrizeEntry = [...prizeCounts.entries()].sort((left, right) => right[1] - left[1])[0];
    const topPrize = topPrizeEntry ? `${topPrizeEntry[0]} (${topPrizeEntry[1]})` : "\u2014";
    const now = new Date();
    const todayCount = spins.filter((spin) => {
      const date = new Date(spin?.createdAt);
      return (
        !Number.isNaN(date.getTime()) &&
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()
      );
    }).length;

    if (elements.ownerTotal) elements.ownerTotal.textContent = String(total);
    if (elements.ownerParticipants) {
      elements.ownerParticipants.textContent = String(participants.size);
    }
    if (elements.ownerToday) elements.ownerToday.textContent = String(todayCount);
    if (elements.ownerTopPrize) elements.ownerTopPrize.textContent = topPrize;
    if (elements.ownerResultsCount) {
      elements.ownerResultsCount.textContent = `${total} record${total === 1 ? "" : "s"}`;
    }
    if (elements.ownerStats) {
      elements.ownerStats.textContent = `${total} recorded spin${total === 1 ? "" : "s"} \u00b7 ${participants.size} named participant${participants.size === 1 ? "" : "s"} \u00b7 Top prize: ${topPrize}`;
    }

    if (!elements.ownerResultsBody) return;
    const isTableBody = elements.ownerResultsBody.tagName === "TBODY";
    const fragment = document.createDocumentFragment();

    if (spins.length === 0) {
      if (isTableBody) {
        const row = document.createElement("tr");
        row.className = "table-empty";
        row.dataset.emptyRow = "";
        const cell = document.createElement("td");
        cell.colSpan = 4;
        cell.textContent = "No recorded spins yet.";
        row.append(cell);
        fragment.append(row);
      } else {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No recorded spins yet.";
        fragment.append(empty);
      }
    }

    spins.forEach((spin) => {
      const label = spin?.result?.label || `Prize ${(Number(spin?.winnerIndex) || 0) + 1}`;
      const participant = spin?.participant || "Guest";
      const choiceCount = Array.isArray(spin?.choices)
        ? spin.choices.length
        : Number.isFinite(Number(spin?.choiceCount))
          ? Number(spin.choiceCount)
          : "\u2014";
      if (isTableBody) {
        const row = document.createElement("tr");
        [formatDate(spin.createdAt), participant, label, String(choiceCount)].forEach(
          (value) => {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.append(cell);
          },
        );
        fragment.append(row);
      } else {
        const row = document.createElement("article");
        row.className = "owner-result-row";
        const result = document.createElement("strong");
        result.textContent = label;
        const details = document.createElement("span");
        details.textContent = `${participant} \u00b7 ${formatDate(spin.createdAt)} \u00b7 ${choiceCount} choices`;
        row.append(result, details);
        fragment.append(row);
      }
    });
    elements.ownerResultsBody.replaceChildren(fragment);
  }

  async function loadOwnerSpins() {
    if (!state.ownerAuthenticated) return;
    setOwnerStatus("Loading private results\u2026");
    try {
      const payload = await fetchJson("/api/admin/spins");
      renderOwnerSpins(payload);
      setOwnerStatus("Private results are up to date.", "success");
    } catch (error) {
      if (error?.status === 401) {
        setOwnerAuthenticated(false);
        setOwnerStatus("Your owner session expired. Please sign in again.", "warning");
      } else {
        setOwnerStatus(error?.message || "Could not load private results.", "error");
      }
    }
  }

  async function checkOwnerSession({ quiet = false } = {}) {
    try {
      const response = await fetchJson("/api/admin/me", {}, 5000);
      const authenticated = response?.authenticated === true;
      setOwnerAuthenticated(authenticated);
      if (authenticated) {
        await loadOwnerSpins();
      } else if (!quiet) {
        setOwnerStatus("Enter the owner PIN to view private results.");
      }
      return authenticated;
    } catch (error) {
      setOwnerAuthenticated(false);
      if (!quiet) {
        setOwnerStatus(
          error?.status === 401
            ? "Enter the owner PIN to view private results."
            : "Owner service is unavailable right now.",
          error?.status === 401 ? "neutral" : "warning",
        );
      }
      return false;
    }
  }

  async function handleOwnerLogin(event) {
    event?.preventDefault();
    if (state.ownerBusy) return;
    const pin = elements.ownerPin?.value || "";
    if (!pin.trim()) {
      setOwnerStatus("Enter your owner PIN.", "error");
      elements.ownerPin?.focus();
      return;
    }
    setOwnerBusy(true);
    setOwnerStatus("Signing in\u2026");
    try {
      const response = await fetchJson("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ pin }),
      });
      if (response?.authenticated !== true) throw new Error("Sign-in was not accepted.");
      if (elements.ownerPin) elements.ownerPin.value = "";
      setOwnerAuthenticated(true);
      await loadOwnerSpins();
    } catch (error) {
      setOwnerAuthenticated(false);
      setOwnerStatus(
        error?.status === 401 ? "That PIN is not correct." : error?.message || "Could not sign in.",
        "error",
      );
      elements.ownerPin?.select();
    } finally {
      setOwnerBusy(false);
    }
  }

  async function handleOwnerLogout() {
    if (state.ownerBusy) return;
    setOwnerBusy(true);
    try {
      await fetchJson("/api/admin/logout", { method: "POST" });
    } catch (_error) {
      // Clear the local owner view even if the server has already ended the session.
    } finally {
      setOwnerAuthenticated(false);
      renderOwnerSpins({ spins: [], count: 0 });
      setOwnerStatus("Signed out.", "success");
      setOwnerBusy(false);
      elements.ownerPin?.focus();
    }
  }

  function setResetStatus(message, tone = "neutral") {
    if (!elements.resetStatus) return;
    elements.resetStatus.textContent = message;
    elements.resetStatus.dataset.tone = tone;
    elements.resetStatus.hidden = !message;
  }

  function setResetBusy(isBusy) {
    state.resetBusy = isBusy;
    [elements.resetConfirm, elements.resetCancel, elements.resetClose].forEach(
      (element) => {
        if (element) element.disabled = isBusy;
      },
    );
    if (elements.resetConfirm) {
      elements.resetConfirm.setAttribute("aria-busy", String(isBusy));
    }
  }

  function openResetDialog() {
    if (!elements.resetDialog || state.resetBusy) return;
    state.resetReturnFocus = document.activeElement;
    setResetStatus("");
    if (typeof elements.resetDialog.showModal === "function") {
      if (!elements.resetDialog.open) elements.resetDialog.showModal();
    } else {
      elements.resetDialog.hidden = false;
      elements.resetDialog.setAttribute("open", "");
    }
    window.setTimeout(
      () => (elements.resetCancel || elements.resetClose || elements.resetConfirm)?.focus(),
      0,
    );
  }

  function closeResetDialog({ restoreFocus = true } = {}) {
    if (!elements.resetDialog || state.resetBusy) return;
    if (typeof elements.resetDialog.close === "function" && elements.resetDialog.open) {
      elements.resetDialog.close();
    } else {
      elements.resetDialog.hidden = true;
      elements.resetDialog.removeAttribute("open");
    }
    const returnTarget = state.resetReturnFocus;
    state.resetReturnFocus = null;
    if (restoreFocus && returnTarget && !returnTarget.disabled && returnTarget.isConnected) {
      returnTarget.focus();
    }
  }

  async function handleOwnerReset(event) {
    event?.preventDefault();
    if (state.resetBusy || !state.ownerAuthenticated) return;
    setResetBusy(true);
    setResetStatus("Starting a fresh campaign round\u2026");
    try {
      const response = await fetchJson("/api/admin/reset", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      if (response?.ok !== true) throw new Error("The campaign round was not reset.");

      clearLocalHistory();
      state.generation =
        response.generation === null || response.generation === undefined
          ? null
          : String(response.generation);
      state.previousSpin = null;
      state.canSpin = false;
      state.eligibilityReady = false;
      writeRoundState({
        generation: state.generation,
        attempted: false,
        previousSpin: null,
      });
      resetVisibleResult();
      renderOwnerSpins({ spins: [], count: 0 });

      setResetBusy(false);
      closeResetDialog();
      await checkEligibility();
      const archivedCount = Number(response.archivedCount) || 0;
      setOwnerStatus(
        `New round ready. ${archivedCount} previous result${archivedCount === 1 ? " was" : "s were"} archived.`,
        "success",
      );
    } catch (error) {
      setResetStatus(error?.message || "Could not start a new round.", "error");
      if (error?.status === 401) {
        setOwnerAuthenticated(false);
      }
      setResetBusy(false);
    }
  }

  async function openOwnerDialog() {
    if (!elements.ownerDialog) return;
    if (typeof elements.ownerDialog.showModal === "function") {
      if (!elements.ownerDialog.open) elements.ownerDialog.showModal();
    } else {
      elements.ownerDialog.hidden = false;
      elements.ownerDialog.setAttribute("open", "");
    }
    setOwnerStatus("Checking owner session\u2026");
    const authenticated = await checkOwnerSession();
    if (!authenticated) elements.ownerPin?.focus();
  }

  function closeOwnerDialog() {
    if (!elements.ownerDialog) return;
    if (typeof elements.ownerDialog.close === "function" && elements.ownerDialog.open) {
      elements.ownerDialog.close();
    } else {
      elements.ownerDialog.hidden = true;
      elements.ownerDialog.removeAttribute("open");
    }
    elements.ownerOpen?.focus();
  }

  function bindEvents() {
    elements.spinButton?.addEventListener("click", handleSpin);
    elements.addChoice?.addEventListener("click", () =>
      setChoiceCount(state.choices.length + 1, true),
    );
    elements.removeChoice?.addEventListener("click", () =>
      removeChoiceAt(state.choices.length - 1),
    );

    if (elements.choiceCount) {
      const handleCount = (event) => {
        if (playControlsLocked()) return;
        setChoiceCount(event.currentTarget.value);
      };
      elements.choiceCount.addEventListener("change", handleCount);
      if (elements.choiceCount instanceof HTMLInputElement) {
        elements.choiceCount.addEventListener("input", handleCount);
      }
    }

    elements.choiceFields?.addEventListener("input", (event) => {
      const input = event.target.closest("[data-choice-index]");
      if (!input || playControlsLocked()) return;
      const index = Number.parseInt(input.dataset.choiceIndex, 10);
      if (!Number.isInteger(index) || !state.choices[index]) return;
      state.choices[index].label = input.value;
      persistSettings();
      scheduleWheelDraw();
    });
    elements.choiceFields?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-choice]");
      if (!button) return;
      removeChoiceAt(Number.parseInt(button.dataset.removeChoice, 10));
    });

    if (elements.showLabels) {
      elements.showLabels.checked = state.showLabels;
      elements.showLabels.addEventListener("change", () => {
        if (playControlsLocked()) return;
        state.showLabels = elements.showLabels.checked;
        persistSettings();
        scheduleWheelDraw();
      });
    }

    elements.clearHistory?.addEventListener("click", () => {
      try {
        window.localStorage.removeItem(HISTORY_KEY);
      } catch (_error) {
        // Rendering an empty list still gives the user immediate feedback.
      }
      renderLocalHistory();
    });

    elements.ownerOpen?.addEventListener("click", openOwnerDialog);
    elements.ownerClose?.addEventListener("click", closeOwnerDialog);
    elements.ownerDashboardClose?.addEventListener("click", closeOwnerDialog);
    elements.ownerLoginButton?.addEventListener("click", handleOwnerLogin);
    elements.ownerLogoutButton?.addEventListener("click", handleOwnerLogout);
    elements.ownerResetButton?.addEventListener("click", openResetDialog);
    const loginForm = elements.ownerLoginButton?.closest("form");
    loginForm?.addEventListener("submit", handleOwnerLogin);
    elements.ownerDialog?.addEventListener("click", (event) => {
      if (event.target === elements.ownerDialog) closeOwnerDialog();
    });

    elements.winnerClose?.addEventListener("click", closeWinnerDialog);
    elements.winnerDialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeWinnerDialog();
    });
    elements.winnerDialog?.addEventListener("click", (event) => {
      if (event.target === elements.winnerDialog) closeWinnerDialog();
    });

    elements.resetCancel?.addEventListener("click", () => closeResetDialog());
    elements.resetClose?.addEventListener("click", () => closeResetDialog());
    elements.resetConfirm?.addEventListener("click", handleOwnerReset);
    const resetForm = elements.resetConfirm?.closest("form");
    resetForm?.addEventListener("submit", handleOwnerReset);
    elements.resetDialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeResetDialog();
    });
    elements.resetDialog?.addEventListener("click", (event) => {
      if (event.target === elements.resetDialog) closeResetDialog();
    });

    if (elements.ownerExport) {
      elements.ownerExport.href = "/api/admin/export.csv";
      elements.ownerExport.setAttribute("download", "drivu-roulette-results.csv");
    }

    window.addEventListener("storage", (event) => {
      if (event.key === HISTORY_KEY) renderLocalHistory();
      if (event.key === ROUND_STATE_KEY && state.eligibilityReady) {
        const round = readRoundState();
        const generationChanged = state.generation !== round.generation;
        state.generation = round.generation;
        state.previousSpin = normalizePreviousSpin(round.previousSpin);
        state.canSpin = !round.attempted && readLocalHistory().length === 0;
        if (generationChanged && !round.attempted) resetVisibleResult();
        if (state.previousSpin && elements.resultLabel) {
          elements.resultLabel.textContent = state.previousSpin.result.label;
        }
        updatePlayControls();
      }
      if (event.key === SETTINGS_KEY && !state.isSpinning) {
        restoreSettings();
        renderChoiceFields();
        if (elements.showLabels) elements.showLabels.checked = state.showLabels;
        scheduleWheelDraw();
      }
    });

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    state.reducedMotion = motionPreference.matches;
    const updateMotionPreference = (event) => {
      state.reducedMotion = event.matches;
    };
    if (typeof motionPreference.addEventListener === "function") {
      motionPreference.addEventListener("change", updateMotionPreference);
    } else if (typeof motionPreference.addListener === "function") {
      motionPreference.addListener(updateMotionPreference);
    }

    if (typeof ResizeObserver === "function" && elements.canvas) {
      const observer = new ResizeObserver(resizeCanvas);
      observer.observe(elements.canvas);
    } else {
      window.addEventListener("resize", resizeCanvas, { passive: true });
    }
  }

  function init() {
    captureElements();
    restoreSettings();
    installTestIds();
    renderChoiceFields();
    renderLocalHistory();
    bindEvents();
    resizeCanvas();
    setSpinning(false);
    setOwnerAuthenticated(false);
    checkHealth();
    checkEligibility();
    if (elements.ownerDialog) checkOwnerSession({ quiet: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
