import * as vscode from "vscode";

// Simple regex to detect the start of a function, class, or method declaration
const BLOCK_START_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(?:function\b|class\b|(?:public|private|protected|static|abstract)\s+.*\()/;

export class LocCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      if (!BLOCK_START_RE.test(line.text)) continue;

      const range = new vscode.Range(i, 0, i, line.text.length);

      lenses.push(
        new vscode.CodeLens(range, {
          title: "LocCode: Explain",
          command: "loccode.explainSelection",
          arguments: [{ line: i }],
        }),
        new vscode.CodeLens(range, {
          title: "Edit",
          command: "loccode.editSelection",
          arguments: [{ line: i }],
        }),
        new vscode.CodeLens(range, {
          title: "Fix",
          command: "loccode.fixSelection",
          arguments: [{ line: i }],
        }),
        new vscode.CodeLens(range, {
          title: "Tests",
          command: "loccode.writeTests",
          arguments: [{ line: i }],
        }),
      );
    }

    return lenses;
  }
}
