import {
  App,
  Plugin,
  ItemView,
  TFile,
  WorkspaceLeaf,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";

// View type constant
const VIEW_TYPE_RAG_CHAT = "rag-chat-view";

// === Settings interface & defaults ===
interface RAGChatSettings {
  ollamaUrl: string;
  llmModel: string;
  embeddingModel: string;
  maxContextTokens: number;
  llmOptions: string[];
  embeddingOptions: string[];
}

const DEFAULT_SETTINGS: RAGChatSettings = {
  ollamaUrl: "http://localhost:11434",
  llmModel: "",
  embeddingModel: "",
  maxContextTokens: 700,
  llmOptions: [],
  embeddingOptions: [],
};

// === Helper to fetch model list from Ollama ===
async function fetchOllamaModels(
  ollamaUrl: string
): Promise<{ llmModels: string[]; embeddingModels: string[] }> {
  try {
    const resp = await fetch(`${ollamaUrl}/api/tags`);
    if (!resp.ok) throw new Error(`HTTP error ${resp.status}`);
    const data = await resp.json();
    const allModels: string[] = data.models?.map((m: any) => m.model) ?? [];

    // Example separation logic: models containing "embed" (case-insensitive) are embedding models
    const embeddingModels = allModels.filter((name) =>
      name.toLowerCase().includes("embed")
    );
    const llmModels = allModels.filter(
      (name) => !name.toLowerCase().includes("embed")
    );

    return {
      llmModels,
      embeddingModels,
    };
  } catch (e) {
    console.warn("Failed to fetch Ollama models:", e);
    // On failure, return empty arrays
    return { llmModels: [], embeddingModels: [] };
  }
}

// === Main Plugin Class ===
export default class RAGChatPlugin extends Plugin {
  settings!: RAGChatSettings;

  async onload() {
    await this.loadSettings();
    await this.refreshModelOptions();

    this.registerView(
      VIEW_TYPE_RAG_CHAT,
      (leaf) => new RAGChatView(leaf, this)
    );

    this.addCommand({
      id: "open-rag-chat",
      name: "Open RAG Chat",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new RAGChatSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => this.activateView());
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_CHAT);
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_CHAT)[0];
    if (!leaf) leaf = this.app.workspace.getLeaf(false);
    if (!leaf) {
      new Notice("Could not open RAG Chat panel.");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_RAG_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async refreshModelOptions() {
    const { ollamaUrl } = this.settings;

    const { llmModels, embeddingModels } = await fetchOllamaModels(ollamaUrl);

    this.settings.llmOptions = llmModels;
    this.settings.embeddingOptions = embeddingModels;

    // Ensure selected models are valid; default to first option if not
    if (!this.settings.llmOptions.includes(this.settings.llmModel)) {
      this.settings.llmModel = this.settings.llmOptions[0] || "";
    }
    if (!this.settings.embeddingOptions.includes(this.settings.embeddingModel)) {
      this.settings.embeddingModel = this.settings.embeddingOptions[0] || "";
    }
    await this.saveSettings();
  }

  // === Search method reused as-is (slight cleanup) ===
  async searchNotes(query: string): Promise<{ file: TFile; snippet: string }[]> {
    const STOP_WORDS = new Set([
      "what", "are", "the", "is", "of", "on", "to", "in", "and", "or",
      "a", "an", "for", "this", "that", "with",
    ]);
    const keywords = query
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word && !STOP_WORDS.has(word));

    const files = this.app.vault.getMarkdownFiles();
    const results: { file: TFile; snippet: string }[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const contentLower = content.toLowerCase();
      if (keywords.some((word) => contentLower.includes(word))) {
        let firstIdx = -1;
        for (const word of keywords) {
          const idx = contentLower.indexOf(word);
          if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) firstIdx = idx;
        }
        const snippet = content
          .slice(Math.max(0, firstIdx - 50), firstIdx + 150)
          .replace(/\n+/g, " ");
        results.push({ file, snippet });
      }
    }
    return results;
  }
}

// === Ollama Helpers that use settings ===

async function ollamaEmbed(text: string, plugin: RAGChatPlugin): Promise<number[]> {
  const resp = await fetch(`${plugin.settings.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: plugin.settings.embeddingModel,
      input: text,
    }),
  });
  const raw = await resp.text();
  const data = safeParseOllamaJson(raw);
  return data.embedding || data.embeddings?.[0];
}

async function ollamaEmbedBatch(
  texts: string[],
  plugin: RAGChatPlugin
): Promise<number[][]> {
  const resp = await fetch(`${plugin.settings.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: plugin.settings.embeddingModel,
      input: texts,
    }),
  });
  const raw = await resp.text();
  const data = safeParseOllamaJson(raw);
  if (!Array.isArray(data.embeddings)) {
    throw new Error("Expected 'embeddings' to be an array.");
  }
  return data.embeddings;
}

async function ollamaChat(
  context: string,
  query: string,
  plugin: RAGChatPlugin
): Promise<string> {
  const resp = await fetch(`${plugin.settings.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: plugin.settings.llmModel,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant for an Obsidian vault. Only answer using the context provided.",
        },
        { role: "user", content: `Context:\n${context}\n\nQuery: ${query}` },
      ],
    }),
  });
  const raw = await resp.text();
  const data = safeParseOllamaJson(raw);
  return data.message?.content || data.response || "[no response]";
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const aMag = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const bMag = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (aMag * bMag + 1e-8);
}

function safeParseOllamaJson(raw: string): any {
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Invalid response: JSON object not found.");
  }
  const jsonFragment = raw.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonFragment);
  } catch (err) {
    console.error("Failed to parse Ollama JSON extract:", jsonFragment);
    throw new Error("Ollama response could not be parsed as JSON.");
  }
}

// === Sidebar Chat View with improved UI ===

class RAGChatView extends ItemView {
  plugin: RAGChatPlugin;
  chatContainer!: HTMLDivElement;
  inputEl!: HTMLTextAreaElement;
  isProcessing = false;

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
    return "message-square";
  }

  async onOpen() {
    const container = this.containerEl;
    container.empty();

    container.setAttr(
      "style",
      "height: 100%; width: 100%; min-width: 200px; display: flex; flex-direction: column; overflow: hidden;"
    );

    const outerContainer = container.createDiv("rag-chat-outer");
    outerContainer.setAttr(
      "style",
      "display: flex; flex-direction: column; flex: 1 1 0; height: 100%; width: 100%; background: var(--background-primary);"
    );

    this.chatContainer = outerContainer.createDiv("rag-chat-messages");
    this.chatContainer.setAttr(
      "style",
      "flex: 1 1 auto; overflow-y: auto; border: 1px solid var(--divider-color); padding: 16px 16px 80px 16px; box-sizing: border-box; border-radius: 8px 8px 0 0;" +
        "background-color: var(--background-modifier-hover); font-size: 15px; min-height: 0; width: 100%;"
    );

    const inputContainer = outerContainer.createDiv();
    inputContainer.setAttr(
      "style",
      "display: flex; flex-shrink: 0; gap: 8px; align-items: stretch;" +
        "width: 100%; box-sizing: border-box; padding: 12px; background: var(--background-primary); border-top: 1px solid var(--divider-color);" +
        "transform: translateY(-5%);"
    );

    // Input textarea
    this.inputEl = inputContainer.createEl("textarea", { placeholder: "Ask a question..." });
    this.inputEl.setAttr("rows", "1");
    this.inputEl.setAttr(
      "style",
      "flex: 1 1 0; min-width: 0; resize: none; max-height: 120px;" +
        "padding: 10px 12px; font-size: 15px; border-radius: 6px;" +
        "border: 1px solid var(--interactive-accent); overflow-y: auto;" +
        "font-family: var(--font-monospace); color: var(--text-normal); box-sizing: border-box;"
    );

    // Automatically resize textarea height
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + "px";
      this.inputEl.style.overflowY = this.inputEl.scrollHeight > 120 ? "auto" : "hidden";
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSubmit();
      }
    });

    // Send button fills height
    const sendButton = inputContainer.createEl("button", { text: "Send" });
    sendButton.setAttr(
      "style",
      `
      flex-shrink: 0;
      height: 100%;
      padding: 0 18px;
      border-radius: 6px;
      border: none;
      background-color: var(--interactive-accent);
      color: var(--text-on-interactive-accent);
      font-weight: 600;
      font-size: 15px;
      cursor: pointer;
      transition: background-color 0.2s;
      user-select: none;
      min-width: 64px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `
    );

    sendButton.onmouseenter = () => {
      sendButton.style.backgroundColor = "var(--interactive-accent-pressed)";
    };
    sendButton.onmouseleave = () => {
      sendButton.style.backgroundColor = "var(--interactive-accent)";
    };
    sendButton.onclick = () => this.handleSubmit();
  }

  addMessage(role: "user" | "rag", text: string) {
    const msg = this.chatContainer.createDiv();
    msg.setAttr(
      "style",
      `margin-bottom: 14px; padding: 14px 20px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; user-select: text;` +
        `width: 100%; box-sizing: border-box; font-size: 15px; line-height: 1.45;` +
        `color: var(--text-normal); background-color: ${
          role === "user"
            ? "var(--background-primary)"
            : "var(--background-secondary-alt)"
        }; border: 1px solid var(--divider-color);` +
        `align-self: ${role === "user" ? "flex-end" : "flex-start"};`
    );
    msg.createSpan({ text });
    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
  }

  approximateTokenCount(text: string): number {
    return text.trim().split(/\s+/).length;
  }

  buildContextWithTokenLimit(
    rankedSnippets: { file: TFile; snippet: string; sim: number }[]
  ): string {
    let tokenCount = 0;
    const chunks: string[] = [];

    for (const r of rankedSnippets) {
      const snippetTokens = this.approximateTokenCount(r.snippet) + 20;
      if (tokenCount + snippetTokens > this.plugin.settings.maxContextTokens) break;
      tokenCount += snippetTokens;
      chunks.push(`File: ${r.file.basename}\n${r.snippet}`);
    }
    return chunks.join("\n\n");
  }

  async handleSubmit() {
    if (this.isProcessing) return;
    const query = this.inputEl.value.trim();
    if (!query) return;

    this.addMessage("user", query);
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.isProcessing = true;
    try {
      const results = await this.plugin.searchNotes(query);
      if (results.length === 0) {
        this.addMessage("rag", "no matching notes found.");
        this.isProcessing = false;
        return;
      }

      this.addMessage("rag", "generating response...");
      const queryEmbedding = await ollamaEmbed(query, this.plugin);
      const snippets = results.map((r) => r.snippet);
      const snippetEmbeddings = await ollamaEmbedBatch(snippets, this.plugin);

      const ranked = results
        .map((res, i) => ({
          ...res,
          sim: cosineSimilarity(queryEmbedding, snippetEmbeddings[i]),
        }))
        .sort((a, b) => b.sim - a.sim);

      const context = this.buildContextWithTokenLimit(ranked);
      const answer = await ollamaChat(context, query, this.plugin);

      this.chatContainer.lastChild?.remove(); // remove "loading" message
      this.addMessage("rag", answer.trim());
    } catch (err: any) {
      this.chatContainer.lastChild?.remove();
      this.addMessage("rag", `❌ Error: ${String(err.message || err)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async onClose() {}
}

// === Settings panel ===
class RAGChatSettingTab extends PluginSettingTab {
  plugin: RAGChatPlugin;

  constructor(app: App, plugin: RAGChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "RAG Chat Plugin Settings" });

    new Setting(containerEl)
      .setName("Ollama URL")
      .setDesc("Base URL for your Ollama server.")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.ollamaUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaUrl = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.refreshModelOptions();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Embedding Model")
      .setDesc("Model for embeddings. Refresh the model list if you add new models.")
      .addDropdown((dd) => {
        if (this.plugin.settings.embeddingOptions.length === 0) {
          dd.addOption("", "-- No embedding models found --");
          dd.setDisabled(true);
          return;
        }
        this.plugin.settings.embeddingOptions.forEach((m) => dd.addOption(m, m));
        dd.setValue(this.plugin.settings.embeddingModel || "");
        dd.onChange(async (value) => {
          this.plugin.settings.embeddingModel = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("LLM Model")
      .setDesc("Language model for answering.")
      .addDropdown((dd) => {
        if (this.plugin.settings.llmOptions.length === 0) {
          dd.addOption("", "-- No LLM models found --");
          dd.setDisabled(true);
          return;
        }
        this.plugin.settings.llmOptions.forEach((m) => dd.addOption(m, m));
        dd.setValue(this.plugin.settings.llmModel || "");
        dd.onChange(async (value) => {
          this.plugin.settings.llmModel = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Max Context Tokens")
      .setDesc("How many tokens to send as context to the model (approximate).")
      .addSlider((slider) =>
        slider
          .setLimits(256, 8192, 64)
          .setValue(this.plugin.settings.maxContextTokens)
          .onChange(async (value) => {
            this.plugin.settings.maxContextTokens = value;
            await this.plugin.saveSettings();
          })
          .setDynamicTooltip()
      );

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Refresh Model List")
        .setCta()
        .onClick(async () => {
          btn.setButtonText("Refreshing...");
          await this.plugin.refreshModelOptions();
          this.display();
          btn.setButtonText("Refresh Model List");
        })
    );
  }
}
