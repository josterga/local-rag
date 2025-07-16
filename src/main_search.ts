import {
  App,
  ItemView,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_RAG_CHAT = "rag-chat-view";

export default class RAGChatPlugin extends Plugin {
  async onload() {
    this.registerView(
      VIEW_TYPE_RAG_CHAT,
      (leaf) => new RAGChatView(leaf, this)
    );

    this.addCommand({
      id: "open-rag-chat",
      name: "Open RAG Chat",
      callback: () => this.activateView(),
    });

    // Only activate once UI is ready
    this.app.workspace.onLayoutReady(() => {
      this.activateView();
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_CHAT);
  }

  async activateView() {
  let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_CHAT)[0];
  if (!leaf) {
    leaf = this.app.workspace.getRightLeaf(true);
  }

  if (!leaf) {
    new Notice("Failed to open or create a sidebar view for RAG Chat.");
    return;
  }

  await leaf.setViewState({
    type: VIEW_TYPE_RAG_CHAT,
    active: true,
  });

  this.app.workspace.revealLeaf(leaf);
}

  async searchNotes(query: string): Promise<{ file: TFile; snippet: string }[]> {
    const files = this.app.vault.getMarkdownFiles();
    const results: { file: TFile; snippet: string }[] = [];

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const index = content.toLowerCase().indexOf(query.toLowerCase());

      if (index !== -1) {
        const snippet = content.slice(Math.max(0, index - 50), index + 150);
        results.push({ file, snippet });
      }
    }

    return results;
  }
}

class RAGChatView extends ItemView {
  plugin: RAGChatPlugin;
  chatContainer!: HTMLDivElement;
  inputEl!: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, plugin: RAGChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RAG_CHAT;
  }

  getDisplayText(): string {
    return "RAG Chat";
  }

  getIcon(): string {
    return "message-square"; // built-in icon
  }

  async onOpen() {
    const container = this.containerEl;
    container.empty();

    container.createEl("h3", { text: "🧠 Local RAG Chat" });

    this.chatContainer = container.createDiv("rag-chat-messages");
    this.chatContainer.setAttr(
      "style",
      "overflow-y: auto; height: 400px; border: 1px solid var(--divider-color); padding: 10px; border-radius: 6px; margin-bottom: 10px;"
    );

    const inputContainer = container.createDiv();
    inputContainer.setAttr("style", "display: flex; gap: 8px;");

    this.inputEl = inputContainer.createEl("input", {
      type: "text",
      placeholder: "Ask a question...",
    });
    this.inputEl.setAttr("style", "flex: 1; padding: 6px;");

    const sendButton = inputContainer.createEl("button", {
      text: "Send",
    });
    sendButton.setAttr("style", "padding: 6px 12px;");
    sendButton.onclick = () => this.handleSubmit();

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.handleSubmit();
      }
    });
  }

  addMessage(role: "user" | "rag", text: string) {
    const msg = this.chatContainer.createDiv();
    msg.setAttr(
      "style",
      `margin-bottom: 10px; padding: 8px; border-radius: 6px; background-color: ${
        role === "user"
          ? "var(--interactive-accent)"
          : "var(--background-secondary-alt)"
      }; color: var(--text-normal); white-space: pre-wrap;`
    );
    msg.createSpan({ text });
    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
  }

  async handleSubmit() {
    const query = this.inputEl.value.trim();
    if (!query) return;

    this.addMessage("user", query);
    this.inputEl.value = "";

    const results = await this.plugin.searchNotes(query);

    if (results.length === 0) {
      this.addMessage("rag", "🧐 No matching notes found.");
      return;
    }

    for (const res of results.slice(0, 3)) {
      const reply = `📄 **${res.file.basename}**\n\n${res.snippet.trim()}...`;
      this.addMessage("rag", reply);
    }
  }

  async onClose() {
    // Optional cleanup
  }
}
