// ===================================================================
// Minimi — Client-side chat application
// ===================================================================

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────
  let currentSessionId = null;
  let isStreaming = false;

  // ── DOM refs ───────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const chatForm = $("#chat-form");
  const messageInput = $("#message-input");
  const sendBtn = $("#send-btn");
  const messagesContainer = $("#messages");
  const welcomeScreen = $("#welcome");
  const sessionList = $("#session-list");
  const newChatBtn = $("#new-chat-btn");
  const sidebarToggle = $("#sidebar-toggle");
  const sidebar = $("#sidebar");

  // ── Markdown renderer setup ────────────────────────────────────
  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  function renderMarkdown(text) {
    const raw = marked.parse(text);
    return DOMPurify.sanitize(raw);
  }

  // ── Session management ─────────────────────────────────────────

  async function loadSessions() {
    try {
      const res = await fetch("/api/sessions");
      const sessions = await res.json();
      renderSessionList(sessions);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  }

  function renderSessionList(sessions) {
    sessionList.innerHTML = "";
    for (const session of sessions) {
      const el = document.createElement("div");
      el.className = "session-item" + (session.id === currentSessionId ? " active" : "");
      el.dataset.id = session.id;

      const title = session.title || "New chat";
      const date = new Date(session.updated_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      el.innerHTML = `${escapeHtml(title)}<span class="session-date">${date}</span>`;
      el.addEventListener("click", () => switchSession(session.id));
      sessionList.appendChild(el);
    }
  }

  async function switchSession(sessionId) {
    currentSessionId = sessionId;
    await loadSessionMessages(sessionId);
    loadSessions(); // Refresh active indicator

    // Close sidebar on mobile
    sidebar.classList.remove("open");
  }

  async function loadSessionMessages(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/messages`);
      const messages = await res.json();

      messagesContainer.innerHTML = "";
      welcomeScreen.classList.add("hidden");
      messagesContainer.classList.add("visible");

      for (const msg of messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          appendMessage(msg.role, msg.content, false);
        }
      }

      scrollToBottom();
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }

  async function createNewSession() {
    currentSessionId = null;
    messagesContainer.innerHTML = "";
    messagesContainer.classList.remove("visible");
    welcomeScreen.classList.remove("hidden");
    messageInput.focus();
    sidebar.classList.remove("open");
    loadSessions();
  }

  // ── Message display ────────────────────────────────────────────

  function appendMessage(role, content, animate = true) {
    const el = document.createElement("div");
    el.className = `message ${role}`;
    if (!animate) el.style.animation = "none";

    const label = role === "user" ? "You" : "Minimi";
    el.innerHTML = `
      <div class="role-label">${label}</div>
      <div class="content">${role === "assistant" ? renderMarkdown(content) : escapeHtml(content)}</div>
    `;

    messagesContainer.appendChild(el);
    scrollToBottom();
    return el;
  }

  function createStreamingMessage() {
    const el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = `
      <div class="role-label">Minimi</div>
      <div class="content"></div>
    `;
    messagesContainer.appendChild(el);
    return el.querySelector(".content");
  }

  function showStatus(text) {
    const el = document.createElement("div");
    el.className = "status-indicator";
    el.innerHTML = `
      <div class="status-badge">
        <div class="spinner"></div>
        <span>${escapeHtml(text)}</span>
      </div>
    `;
    messagesContainer.appendChild(el);
    scrollToBottom();
    return el;
  }

  function removeStatus(el) {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  // ── Chat submission ────────────────────────────────────────────

  async function sendMessage(text) {
    if (isStreaming || !text.trim()) return;

    isStreaming = true;
    sendBtn.disabled = true;

    // Show messages area
    welcomeScreen.classList.add("hidden");
    messagesContainer.classList.add("visible");

    // Append user message
    appendMessage("user", text);

    // Clear input
    messageInput.value = "";
    autoResizeInput();

    // Start streaming
    let statusEl = null;
    let streamContent = null;
    let fullText = "";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: currentSessionId,
          message: text,
        }),
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        let eventType = null;

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            try {
              const data = JSON.parse(dataStr);

              if (eventType === "session") {
                // Capture session ID for new sessions
                currentSessionId = data.id;
                continue;
              }

              const { type, data: content } = data;

              switch (type) {
                case "status":
                  if (statusEl) removeStatus(statusEl);
                  statusEl = showStatus(content);
                  break;

                case "chunk":
                  if (statusEl) {
                    removeStatus(statusEl);
                    statusEl = null;
                  }
                  if (!streamContent) {
                    streamContent = createStreamingMessage();
                  }
                  fullText += content;
                  streamContent.innerHTML = renderMarkdown(fullText);
                  scrollToBottom();
                  break;

                case "error":
                  if (statusEl) removeStatus(statusEl);
                  if (!streamContent) {
                    streamContent = createStreamingMessage();
                  }
                  fullText += `\n\n**Error:** ${content}`;
                  streamContent.innerHTML = renderMarkdown(fullText);
                  break;

                case "done":
                  if (statusEl) removeStatus(statusEl);
                  break;
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } catch (err) {
      console.error("Chat error:", err);
      if (!streamContent) {
        streamContent = createStreamingMessage();
      }
      streamContent.innerHTML = renderMarkdown(
        `**Error:** ${err.message}. Please check that the server is running and API keys are configured.`
      );
    } finally {
      if (statusEl) removeStatus(statusEl);
      isStreaming = false;
      sendBtn.disabled = false;
      messageInput.focus();

      // Refresh session list (title may have been generated)
      setTimeout(loadSessions, 500);
    }
  }

  // ── Input handling ─────────────────────────────────────────────

  function autoResizeInput() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(messageInput.value);
  });

  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(messageInput.value);
    }
  });

  messageInput.addEventListener("input", autoResizeInput);

  newChatBtn.addEventListener("click", createNewSession);

  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
  });

  // ── Helpers ────────────────────────────────────────────────────

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Init ───────────────────────────────────────────────────────
  loadSessions();
})();

