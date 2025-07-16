import {
  App,
  Plugin,
  ItemView,
  TFile,
  WorkspaceLeaf,
  Notice,
} from "obsidian";

const VIEW_TYPE_RAG_CHAT = "rag-chat-view";

// === Ollama config ===
const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_EMBEDDING_MODEL = "mxbai-embed-large"; // or "nomic-embed-text"
const OLLAMA_LLM_MODEL = "llama3";

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

    this.app.workspace.onLayoutReady(() => {
      this.activateView();
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_CHAT);
  }

  async activateView() {
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_CHAT)[0] ?? null;
    if (!leaf) leaf = this.app.workspace.getRightLeaf(true);
    if (!leaf) {
      new Notice("Could not open RAG Chat panel.");
      return;
    }
    await leaf.setViewState({
      type: VIEW_TYPE_RAG_CHAT,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async searchNotes(query: string): Promise<{ file: TFile; snippet: string }[]> {
  const STOP_WORDS = new Set([
    "what", "are", "the", "is", "of", "on", "to", "in", "and", "or",
    "a", "an", "for", "this", "that", "with"
  ]);

  const keywords = query
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word && !STOP_WORDS.has(word));

  console.log("Filtered keywords:", keywords);

  const files = this.app.vault.getMarkdownFiles();
  const results: { file: TFile; snippet: string }[] = [];

  for (const file of files) {
    const content = await this.app.vault.read(file);
    const contentLower = content.toLowerCase();

    if (keywords.some(word => contentLower.includes(word))) {
      let firstIdx = -1;
      for (const word of keywords) {
        const idx = contentLower.indexOf(word);
        if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
          firstIdx = idx;
        }
      }

      const snippet = content.slice(
        Math.max(0, firstIdx - 50),
        firstIdx + 150
      ).replace(/\n+/g, " ");
      results.push({ file, snippet });
    }
  }

  return results;
}

}

// === Ollama Helpers ===

async function ollamaEmbed(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBEDDING_MODEL, input: text }),
  });

  const raw = await resp.text();
  const data = safeParseOllamaJson(raw);

  return data.embedding || data.embeddings?.[0];
}

async function ollamaEmbedBatch(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBEDDING_MODEL, input: texts }),
  });

  const raw = await resp.text();
  const data = safeParseOllamaJson(raw);

  if (!Array.isArray(data.embeddings)) {
    throw new Error("Expected 'embeddings' to be an array.");
  }

  return data.embeddings;
}

async function ollamaChat(context: string, query: string): Promise<string> {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_LLM_MODEL,
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
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
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
// === Sidebar Chat View ===

class RAGChatView extends ItemView {
  plugin: RAGChatPlugin;
  chatContainer!: HTMLDivElement;
  inputEl!: HTMLInputElement;
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

    container.createEl("h3", { text: "local-rag" });

    this.chatContainer = container.createDiv("rag-chat-messages");
    this.chatContainer.setAttr(
      "style",
      "overflow-y:auto;height:320px;border:1px solid var(--divider-color);padding:10px;border-radius:6px;margin-bottom:8px;"
    );

    const inputContainer = container.createDiv();
    inputContainer.setAttr("style", "display:flex;gap:8px;");

    this.inputEl = inputContainer.createEl("input", {
      type: "text",
      placeholder: "Ask a question...",
    });
    this.inputEl.setAttr("style", "flex:1;padding:6px;");

    const sendButton = inputContainer.createEl("button", { text: "Send" });
    sendButton.setAttr("style", "padding:6px 12px;");
    sendButton.onclick = () => this.handleSubmit();

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.handleSubmit();
    });
  }

  addMessage(role: "user" | "rag", text: string) {
    const msg = this.chatContainer.createDiv();
    msg.setAttr(
      "style",
      `margin-bottom:10px;padding:9px;border-radius:6px;background-color:${
        role === "user"
          ? "var(--interactive-accent)"
          : "var(--background-secondary-alt)"
      };color:var(--text-normal);white-space:pre-wrap;`
    );
    msg.createSpan({ text });
    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
  }

  async handleSubmit() {
    if (this.isProcessing) return;
    const query = this.inputEl.value.trim();
    if (!query) return;

    this.addMessage("user", query);
    this.inputEl.value = "";
    this.isProcessing = true;
    console.log("Query sent to searchNotes:", query);
    try {
      const results = await this.plugin.searchNotes(query);
      if (results.length === 0) {
        this.addMessage("rag", "🧐 No matching notes found.");
        return;
      }

      this.addMessage("rag", "🧠 Embedding & generating response...");

      const queryEmbedding = await ollamaEmbed(query);
      const snippets = results.map((r) => r.snippet);
      const snippetEmbeddings = await ollamaEmbedBatch(snippets);

      const ranked = results
        .map((res, i) => ({
          ...res,
          sim: cosineSimilarity(queryEmbedding, snippetEmbeddings[i]),
        }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 3);

      const context = ranked
        .map((r) => `File: ${r.file.basename}\n${r.snippet}`)
        .join("\n\n");

      const answer = await ollamaChat(context, query);
      this.chatContainer.lastChild?.remove(); // remove loading message
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
