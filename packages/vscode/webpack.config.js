/* eslint-disable */
const path = require("node:path");
const webpack = require("webpack");

// Resolve the memory worker script path at build time (before webpack bundling)
// so it can be injected as a string constant into the bundle.
const coreEntry = require.resolve("@loccode/core");
const memoryWorkerScript = coreEntry.replace(/index\.cjs$/, "memory/worker-process.js");

/** @type {import('webpack').Configuration[]} */
module.exports = [
  // ── Extension host (Node.js) ─────────────────────────────────────────────
  {
    target: "node",
    mode: "none",
    entry: "./src/extension.ts",
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "extension.js",
      libraryTarget: "commonjs2",
      devtoolModuleFilenameTemplate: "../[resource-path]",
    },
    externals: {
      // VS Code API — provided by the runtime, never bundled
      vscode: "commonjs vscode",
    },
    resolve: {
      extensions: [".ts", ".js"],
      // Prefer the CJS build of @loccode/core so webpack can bundle it
      conditionNames: ["require", "node", "default"],
      // Stub out native modules — the VS Code extension doesn't use memory
      alias: {
        "better-sqlite3": path.resolve(__dirname, "src/stubs/empty.js"),
        "@xenova/transformers": path.resolve(__dirname, "src/stubs/empty.js"),
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
      ],
    },
    plugins: [
      new webpack.DefinePlugin({
        MEMORY_WORKER_SCRIPT: JSON.stringify(memoryWorkerScript),
      }),
    ],
    devtool: "nosources-source-map",
    infrastructureLogging: { level: "log" },
  },

  // ── Webview (browser) ────────────────────────────────────────────────────
  {
    target: "web",
    mode: "none",
    entry: "./src/webview/chat.ts",
    output: {
      path: path.resolve(__dirname, "dist", "webview"),
      filename: "chat.js",
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
      ],
    },
    devtool: "nosources-source-map",
  },
];
