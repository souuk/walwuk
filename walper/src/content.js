(function startWalper() {
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    expanded: true,
    side: "auto",
    turn: "auto",
    p1Walls: "",
    p2Walls: "",
  });

  let settings = { ...DEFAULT_SETTINGS };
  let root = null;
  let scanTimer = 0;
  let currentScan = null;
  let currentState = null;
  let currentSignature = "";
  let lastRequestedSignature = "";

  function numberAttribute(element, name) {
    return Number.parseFloat(element.getAttribute(name) ?? "NaN");
  }

  function isCellRect(rect) {
    const x = numberAttribute(rect, "x");
    const y = numberAttribute(rect, "y");
    return numberAttribute(rect, "width") === 60 &&
      numberAttribute(rect, "height") === 60 &&
      Number.isInteger(x / 72) && Number.isInteger(y / 72) &&
      x >= 0 && x <= 576 && y >= 0 && y <= 576;
  }

  function findBoard() {
    const svg = document.querySelector('svg[role="grid"][aria-label="Wallz board"]');
    if (!svg) return null;
    const cells = [...svg.querySelectorAll("rect")].filter(isCellRect);
    if (cells.length < 81) return null;
    const parentCounts = new Map();
    for (const cell of cells) {
      parentCounts.set(cell.parentElement, (parentCounts.get(cell.parentElement) ?? 0) + 1);
    }
    const layer = [...parentCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
    return layer ? { svg, layer } : null;
  }

  function pawnPosition(group) {
    const circle = group.querySelector('circle[r="20"]');
    if (circle) {
      return {
        x: Math.round((numberAttribute(circle, "cx") - 30) / 72),
        y: Math.round((numberAttribute(circle, "cy") - 30) / 72),
      };
    }
    const image = group.querySelector('image[width="40"][height="40"]');
    if (!image) return null;
    return {
      x: Math.round((numberAttribute(image, "x") + 20 - 30) / 72),
      y: Math.round((numberAttribute(image, "y") + 20 - 30) / 72),
    };
  }

  function scanPawns(layer) {
    const groups = [...layer.children].filter((element) =>
      element.tagName.toLowerCase() === "g" &&
      Boolean(element.querySelector('circle[r="20"], image[width="40"][height="40"]')),
    ).slice(-2);
    if (groups.length !== 2) return null;
    const result = { p1: null, p2: null };
    let turn = null;
    groups.forEach((group, index) => {
      const titledPlayer = [...group.querySelectorAll("title")]
        .map((title) => title.textContent?.trim())
        .find((text) => text === "p1" || text === "p2");
      const player = titledPlayer ?? (index === 0 ? "p1" : "p2");
      result[player] = pawnPosition(group);
      if (group.querySelector('circle[r="22"]')) turn = player;
    });
    return result.p1 && result.p2 ? { pawns: result, turn } : null;
  }

  function scanWalls(layer) {
    const walls = [];
    for (const rect of layer.querySelectorAll(":scope > rect")) {
      if (rect.matches("[data-walper-suggestion], .walper-board-suggestion")) continue;
      if (rect.hasAttribute("stroke")) continue;
      const width = numberAttribute(rect, "width");
      const height = numberAttribute(rect, "height");
      const x = numberAttribute(rect, "x");
      const y = numberAttribute(rect, "y");
      if (width === 132 && height === 12) {
        walls.push({ x: Math.round(x / 72), y: Math.round((y - 60) / 72), o: "h" });
      } else if (width === 12 && height === 132) {
        walls.push({ x: Math.round((x - 60) / 72), y: Math.round(y / 72), o: "v" });
      }
    }
    return walls.filter((wall) =>
      wall.x >= 0 && wall.x < 8 && wall.y >= 0 && wall.y < 8,
    );
  }

  function styledPlayer(element) {
    let current = element;
    for (let level = 0; current && level < 6; level += 1, current = current.parentElement) {
      const currentStyle = current.getAttribute?.("style") ?? "";
      if (currentStyle.includes("--color-p1")) return "p1";
      if (currentStyle.includes("--color-p2")) return "p2";
      for (const styled of current.querySelectorAll("[style]")) {
        const style = styled.getAttribute("style") ?? "";
        if (style.includes("--color-p1")) return "p1";
        if (style.includes("--color-p2")) return "p2";
      }
    }
    return null;
  }

  function scanWallReserves(userSide, walls, layer) {
    const remaining = { p1: null, p2: null };
    const labels = [...document.querySelectorAll("span")].filter((span) =>
      /^walls\s*·\s*\d+$/i.test(span.textContent?.trim() ?? ""),
    );
    labels.forEach((label, index) => {
      const value = Number.parseInt(label.textContent.match(/\d+/)?.[0] ?? "", 10);
      let player = styledPlayer(label);
      if (!player && labels.length === 2) {
        player = index === 0 ? (userSide === "p1" ? "p2" : "p1") : userSide;
      }
      if (player && Number.isInteger(value)) remaining[player] = value;
    });

    if (remaining.p1 === null || remaining.p2 === null) {
      const placed = { p1: 0, p2: 0 };
      for (const rect of layer.querySelectorAll(":scope > rect")) {
        const fill = `${rect.getAttribute("fill") ?? ""};${rect.getAttribute("style") ?? ""}`;
        if (fill.includes("--color-p1")) placed.p1 += 1;
        if (fill.includes("--color-p2")) placed.p2 += 1;
      }
      remaining.p1 ??= Math.max(0, 10 - placed.p1);
      remaining.p2 ??= Math.max(0, 10 - placed.p2);
    }

    const totalUsed = 20 - remaining.p1 - remaining.p2;
    if (totalUsed < walls.length) {
      remaining.p1 = Math.max(0, remaining.p1 - (walls.length - totalUsed));
    }
    return remaining;
  }

  function scanBoard() {
    const board = findBoard();
    if (!board) return { ok: false, reason: "waiting for a Wallz board" };
    const pawnScan = scanPawns(board.layer);
    if (!pawnScan) return { ok: false, reason: "pawns are still rendering" };
    const inferredSide = (board.layer.getAttribute("transform") ?? "").includes("rotate(180")
      ? "p1"
      : "p2";
    const walls = scanWalls(board.layer);
    const wallsRemaining = scanWallReserves(inferredSide, walls, board.layer);
    const turn = pawnScan.turn;
    if (!turn) return { ok: false, reason: "game finished or turn is not visible" };
    return {
      ok: true,
      svg: board.svg,
      layer: board.layer,
      flipped: inferredSide === "p1",
      inferredSide,
      pawns: pawnScan.pawns,
      turn,
      walls,
      wallsRemaining,
    };
  }

  function effectiveSide(scan) {
    return settings.side === "p1" || settings.side === "p2" ? settings.side : scan.inferredSide;
  }

  function createOverlay() {
    if (root?.isConnected) return root;
    root = document.createElement("aside");
    root.id = "walper-root";
    root.innerHTML = `
      <header class="walper-header">
        <strong>walper</strong>
        <button type="button" data-action="collapse" aria-label="collapse walper">−</button>
      </header>
      <div class="walper-body">
        <div class="walper-status" data-field="status">waiting for a Wallz board</div>
        <div class="walper-best" data-field="best">—</div>
        <dl class="walper-grid">
          <dt>side</dt><dd data-field="side">—</dd>
          <dt>turn</dt><dd data-field="turn">—</dd>
          <dt>walls</dt><dd data-field="walls">—</dd>
          <dt>winning</dt><dd data-field="winning">—</dd>
          <dt>nodes</dt><dd data-field="nodes">0</dd>
          <dt>depth</dt><dd data-field="depth">—</dd>
          <dt>speed</dt><dd data-field="speed">—</dd>
        </dl>
        <details>
          <summary>settings</summary>
          <label><span>analysis</span><input data-setting="enabled" type="checkbox"></label>
          <label><span>my side</span><select data-setting="side">
            <option value="auto">auto</option><option value="p1">p1</option><option value="p2">p2</option>
          </select></label>
          <label><span>turn</span><select data-setting="turn">
            <option value="auto">auto</option><option value="p1">p1</option><option value="p2">p2</option>
          </select></label>
          <label><span>p1 walls</span><input data-setting="p1Walls" type="number" min="0" max="10" placeholder="auto"></label>
          <label><span>p2 walls</span><input data-setting="p2Walls" type="number" min="0" max="10" placeholder="auto"></label>
          <button type="button" class="walper-rescan" data-action="rescan">rescan</button>
        </details>
      </div>`;
    document.documentElement.append(root);
    root.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      settings.expanded = !settings.expanded;
      applyExpandedState();
      chrome.storage.local.set({ walperSettings: settings });
    });
    root.querySelector('[data-action="rescan"]').addEventListener("click", () => {
      lastRequestedSignature = "";
      scheduleScan(0);
    });
    for (const input of root.querySelectorAll("[data-setting]")) {
      input.addEventListener("change", () => {
        const key = input.dataset.setting;
        settings[key] = input.type === "checkbox"
          ? input.checked
          : input.value;
        chrome.storage.local.set({ walperSettings: settings });
        lastRequestedSignature = "";
        scheduleScan(0);
      });
    }
    syncSettingsControls();
    applyExpandedState();
    return root;
  }

  function applyExpandedState() {
    if (!root) return;
    root.classList.toggle("walper-collapsed", !settings.expanded);
    root.querySelector('[data-action="collapse"]').textContent = settings.expanded ? "−" : "+";
  }

  function syncSettingsControls() {
    if (!root) return;
    for (const input of root.querySelectorAll("[data-setting]")) {
      const key = input.dataset.setting;
      if (input.type === "checkbox") input.checked = Boolean(settings[key]);
      else input.value = settings[key];
    }
  }

  function setField(name, value) {
    const field = root?.querySelector(`[data-field="${name}"]`);
    if (field) field.textContent = value;
  }

  function clearSuggestion() {
    currentScan?.svg?.querySelectorAll("[data-walper-suggestion]").forEach((node) => node.remove());
  }

  function resetAnalysisFields(status = "scanning") {
    setField("status", status);
    setField("best", "—");
    setField("winning", "—");
    setField("nodes", "0");
    setField("depth", "—");
    setField("speed", "—");
  }

  function invalidateAnalysis(status = "reading new turn") {
    const signature = currentSignature;
    currentSignature = "";
    currentState = null;
    lastRequestedSignature = "";
    clearSuggestion();
    resetAnalysisFields(status);
    if (signature) {
      chrome.runtime.sendMessage({
        type: "walper-cancel",
        signature,
      }).catch(() => undefined);
    }
  }

  function drawSuggestion(move) {
    clearSuggestion();
    if (!move || !currentScan?.layer?.isConnected) return;
    const marker = document.createElementNS(SVG_NAMESPACE, "rect");
    marker.dataset.walperSuggestion = "true";
    marker.setAttribute("class", "walper-board-suggestion");
    marker.setAttribute("rx", move.kind === "pawn" ? "12" : "5");
    if (move.kind === "pawn") {
      marker.setAttribute("x", String(72 * move.to.c + 3));
      marker.setAttribute("y", String(72 * move.to.r + 3));
      marker.setAttribute("width", "54");
      marker.setAttribute("height", "54");
    } else if (move.wall.o === "h") {
      marker.setAttribute("x", String(72 * move.wall.c));
      marker.setAttribute("y", String(72 * move.wall.r + 60));
      marker.setAttribute("width", "132");
      marker.setAttribute("height", "12");
    } else {
      marker.setAttribute("x", String(72 * move.wall.c + 60));
      marker.setAttribute("y", String(72 * move.wall.r));
      marker.setAttribute("width", "12");
      marker.setAttribute("height", "132");
    }
    currentScan.layer.append(marker);
  }

  function displayAnalysis(result, signature) {
    if (!result || signature !== currentSignature) return;
    setField("status", result.stopReason === "depth" && result.depth >= 15 ? "done" : "scanning");
    setField("best", globalThis.WalperCore.formatMove(result.bestMove, currentScan?.flipped));
    setField("winning", globalThis.WalperCore.formatEvaluation(result, currentState));
    setField("nodes", Number(result.nodes || 0).toLocaleString());
    setField("depth", `${result.depth} ply`);
    setField("speed", `${Number(result.nps || 0).toLocaleString()} nps`);
    drawSuggestion(result.bestMove);
  }

  function displayScan(scan) {
    if (!scan.ok) {
      setField("status", scan.reason);
      setField("best", "—");
      setField("side", "—");
      setField("turn", "—");
      setField("walls", "—");
      setField("winning", "—");
      setField("nodes", "0");
      setField("depth", "—");
      setField("speed", "—");
      clearSuggestion();
      return;
    }
    const side = effectiveSide(scan);
    const turn = settings.turn === "p1" || settings.turn === "p2" ? settings.turn : scan.turn;
    setField("side", `${side}${settings.side === "auto" ? " · auto" : ""}`);
    setField("turn", `${turn}${turn === side ? " · you" : " · opponent"}`);
    setField("walls", `p1 ${scan.wallsRemaining.p1} · p2 ${scan.wallsRemaining.p2}`);
  }

  function requestAnalysis(scan) {
    const overrides = {
      turn: settings.turn === "auto" ? null : settings.turn,
      p1Walls: settings.p1Walls,
      p2Walls: settings.p2Walls,
    };
    const state = globalThis.WalperCore.toEngineState(scan, overrides);
    const signature = globalThis.WalperCore.stateSignature(state);
    if (currentSignature && signature !== currentSignature) invalidateAnalysis();
    currentSignature = signature;
    currentState = state;
    if (!settings.enabled) {
      invalidateAnalysis("offline");
      return;
    }
    if (signature === lastRequestedSignature) return;
    lastRequestedSignature = signature;
    setField("status", "scanning");
    setField("best", "thinking…");
    setField("winning", "—");
    setField("nodes", "0");
    setField("depth", "—");
    setField("speed", "—");
    chrome.runtime.sendMessage({
      type: "walper-analyze",
      state,
      signature,
    }).then((response) => {
      if (!response || response.signature !== currentSignature) return;
      if (!response.ok) {
        setField("status", "engine error");
        setField("best", response.error ?? "unable to analyze");
        return;
      }
    }).catch(() => {
      if (signature !== currentSignature) return;
      setField("status", "engine offline");
      setField("best", "reload the extension");
    });
  }

  function runScan() {
    createOverlay();
    const scan = scanBoard();
    currentScan = scan.ok ? scan : currentScan;
    if (!scan.ok && currentSignature) invalidateAnalysis(scan.reason);
    displayScan(scan);
    if (scan.ok) requestAnalysis(scan);
  }

  function scheduleScan(delay = 180) {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(runScan, delay);
  }

  function walperOwnedNode(node) {
    if (!(node instanceof Element)) return false;
    return node === root || root?.contains(node) ||
      node.matches("[data-walper-suggestion], .walper-board-suggestion");
  }

  function walperOwnedMutation(mutation) {
    if (walperOwnedNode(mutation.target)) return true;
    if (mutation.type !== "childList") return false;
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return changedNodes.length > 0 && changedNodes.every(walperOwnedNode);
  }

  function mutationChangesPosition(mutation) {
    const boardLayer = currentScan?.layer;
    if (!boardLayer?.isConnected) return false;
    const target = mutation.target instanceof Element ? mutation.target : null;
    if (!target || (target !== boardLayer && !boardLayer.contains(target))) return false;
    if (mutation.type === "attributes") {
      return ["cx", "cy", "x", "y"].includes(mutation.attributeName) &&
        target.matches('circle[r="20"], image[width="40"][height="40"]');
    }
    if (mutation.type !== "childList") return false;
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return changedNodes.some((node) => {
      if (!(node instanceof Element) || walperOwnedNode(node)) return false;
      if (node.matches('circle[r="20"], circle[r="22"], image[width="40"][height="40"]')) {
        return true;
      }
      if (node.matches("rect")) {
        const width = numberAttribute(node, "width");
        const height = numberAttribute(node, "height");
        return (width === 132 && height === 12) || (width === 12 && height === 132);
      }
      return Boolean(node.querySelector?.(
        'circle[r="20"], circle[r="22"], image[width="40"][height="40"]',
      ));
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "walper-toggle") {
      settings.expanded = !settings.expanded;
      createOverlay();
      applyExpandedState();
      chrome.storage.local.set({ walperSettings: settings });
    } else if (message?.type === "walper-progress" || message?.type === "walper-done") {
      displayAnalysis(message.result, message.signature);
    } else if (message?.type === "walper-error" && message.signature === currentSignature) {
      setField("status", "engine error");
      setField("best", message.error ?? "unable to analyze");
      clearSuggestion();
    }
  });

  chrome.storage.local.get("walperSettings").then(({ walperSettings }) => {
    settings = { ...DEFAULT_SETTINGS, ...(walperSettings ?? {}) };
    createOverlay();
    syncSettingsControls();
    applyExpandedState();
    scheduleScan(0);
  });

  const observer = new MutationObserver((mutations) => {
    if (mutations.every(walperOwnedMutation)) return;
    if (mutations.some(mutationChangesPosition)) {
      scheduleScan(0);
      return;
    }
    scheduleScan();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ["cx", "cy", "x", "y", "width", "height", "transform", "style"],
  });
})(globalThis);
