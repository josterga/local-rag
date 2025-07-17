import { Plugin, TFile } from "obsidian";
interface RAGChatSettings {
    ollamaUrl: string;
    llmModel: string;
    embeddingModel: string;
    maxContextTokens: number;
    llmOptions: string[];
    embeddingOptions: string[];
}
export default class RAGChatPlugin extends Plugin {
    settings: RAGChatSettings;
    onload(): Promise<void>;
    onunload(): void;
    activateView(): Promise<void>;
    loadSettings(): Promise<void>;
    saveSettings(): Promise<void>;
    refreshModelOptions(): Promise<void>;
    searchNotes(query: string): Promise<{
        file: TFile;
        snippet: string;
    }[]>;
}
export {};
