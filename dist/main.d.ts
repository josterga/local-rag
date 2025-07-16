import { Plugin, TFile } from "obsidian";
export default class RAGChatPlugin extends Plugin {
    onload(): Promise<void>;
    onunload(): void;
    activateView(): Promise<void>;
    searchNotes(query: string): Promise<{
        file: TFile;
        snippet: string;
    }[]>;
}
