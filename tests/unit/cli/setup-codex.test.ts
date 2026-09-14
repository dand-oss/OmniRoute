import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fallbackCodexProfile,
  isCodexCompatibleTextModel,
  syncCodexProfilesFromModels,
} from "../../../bin/cli/commands/setup-codex.mjs";
import {
  buildCodexModelCatalog,
  captureCodexNativeCatalog,
  setCodexModelCatalogConfig,
  syncCodexModelCatalog,
} from "../../../bin/cli/commands/codex-model-catalog.mjs";

const nativeCatalog = {
  models: [
    {
      slug: "gpt-native",
      display_name: "GPT Native",
      visibility: "list",
      supported_in_api: true,
      priority: 10,
      base_instructions: "You are Codex, an agent based on GPT Native.",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      default_reasoning_level: "low",
      supports_parallel_tool_calls: true,
    },
    {
      slug: "gpt-hidden",
      display_name: "GPT Hidden",
      visibility: "hide",
      supported_in_api: true,
      priority: 999,
      base_instructions: "Hidden native template",
      supported_reasoning_levels: [{ effort: "low" }],
    },
  ],
};

test("fallbackCodexProfile creates profiles for compatible live catalog models", () => {
  const cfg = fallbackCodexProfile("new-provider/future-chat-1", {
    id: "new-provider/future-chat-1",
    context_length: 250000,
    max_output_tokens: 65536,
    output_modalities: ["text"],
  });

  assert.deepEqual(cfg, {
    name: "new-provider-future-chat-1",
    ctx: 250000,
    compact: 212500,
    summary: false,
    toolLimit: 32768,
  });
});

test("fallbackCodexProfile skips media and non-text models", () => {
  assert.equal(
    isCodexCompatibleTextModel({
      id: "antigravity/gemini-3.1-flash-image",
      type: "image",
      output_modalities: ["image"],
    }),
    false
  );
  assert.equal(
    fallbackCodexProfile("veo-free/seedance", {
      id: "veo-free/seedance",
      name: "Seedance",
      context_length: 128000,
    }),
    null
  );
});

test("syncCodexProfilesFromModels writes compatible profiles and skips media", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-codex-profiles-"));
  try {
    const result = await syncCodexProfilesFromModels(
      [
        {
          id: "new-provider/future-chat-1",
          context_length: 250000,
          output_modalities: ["text"],
        },
        {
          id: "video-provider/seedance",
          type: "video",
          output_modalities: ["video"],
        },
      ],
      { codexHome }
    );

    assert.equal(result.written, 1);
    assert.equal(result.skipped, 1);
    const content = await fs.readFile(
      path.join(codexHome, "new-provider-future-chat-1.config.toml"),
      "utf8"
    );
    assert.match(content, /model\s+= "new-provider\/future-chat-1"/);
    await assert.rejects(
      fs.stat(path.join(codexHome, "video-provider-seedance.config.toml")),
      /ENOENT/
    );
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("buildCodexModelCatalog preserves native templates and adds compatible OmniRoute models", () => {
  const result = buildCodexModelCatalog(nativeCatalog, [
    {
      id: "zai/glm-5.3",
      name: "GLM 5.3",
      description: "Coding Plan model",
      context_length: 250000,
      capabilities: { effort_tiers: ["low", "high"] },
      output_modalities: ["text"],
    },
    {
      id: "veo/seedance",
      name: "Seedance",
      type: "video",
      output_modalities: ["video"],
    },
  ]);

  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(
    result.models.map((model) => model.slug),
    ["gpt-native", "gpt-hidden", "zai/glm-5.3"]
  );

  const native = result.models[0];
  assert.equal(native.visibility, "list");
  assert.equal(native.supports_parallel_tool_calls, true);

  const routed = result.models[2];
  assert.equal(routed.display_name, "GLM 5.3");
  assert.equal(routed.description, "Coding Plan model");
  assert.equal(routed.priority, 11);
  assert.equal(routed.context_window, 250000);
  assert.equal(routed.max_context_window, 250000);
  assert.deepEqual(routed.supported_reasoning_levels, [
    { effort: "low", description: "Fast reasoning for simple edits" },
    { effort: "high", description: "Deep reasoning with thinking enabled" },
  ]);
  assert.equal(routed.default_reasoning_level, "low");
  assert.equal(routed.visibility, "list");
  assert.equal(routed.supports_parallel_tool_calls, false);
  assert.equal(routed.prefer_websockets, false);
  assert.match(routed.base_instructions, /based on GLM 5\.3\./);
});

test("buildCodexModelCatalog omits reasoning fields when no effort is known", () => {
  const result = buildCodexModelCatalog(nativeCatalog, [
    { id: "provider/simple-chat", context_length: 128000, output_modalities: ["text"] },
  ]);
  const routed = result.models.at(-1);

  assert.equal(Object.hasOwn(routed, "supported_reasoning_levels"), false);
  assert.equal(Object.hasOwn(routed, "default_reasoning_level"), false);
});

test("setCodexModelCatalogConfig inserts only into the TOML root and preserves sections", () => {
  const before = [
    "# user comment",
    'model = "gpt-native"',
    "",
    "[model_providers.omniroute]",
    'base_url = "http://localhost:20128/v1"',
  ].join("\n");
  const after = setCodexModelCatalogConfig(before, "/tmp/omniroute-models.json");

  assert.match(after, /^# user comment\n/);
  assert.match(after, /^model_catalog_json = "\/tmp\/omniroute-models\.json"$/m);
  assert.match(after, /^\[model_providers\.omniroute\]$/m);
  assert.ok(after.indexOf("model_catalog_json") > after.indexOf("model ="));

  assert.throws(
    () =>
      setCodexModelCatalogConfig('model_catalog_json = "/user/owned.json"\n', "/tmp/other.json"),
    /Refusing to replace/
  );
});

test("syncCodexModelCatalog writes private catalog and activates config explicitly", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-codex-catalog-"));
  try {
    const dryRun = await syncCodexModelCatalog({
      nativeCatalog,
      models: [{ id: "zai/glm-5.3", context_length: 250000, output_modalities: ["text"] }],
      codexHome,
      activate: true,
      dryRun: true,
    });
    assert.equal(dryRun.dryRun, true);
    await assert.rejects(fs.stat(path.join(codexHome, "omniroute-model-catalog.json")), /ENOENT/);

    const result = await syncCodexModelCatalog({
      nativeCatalog,
      models: [{ id: "zai/glm-5.3", context_length: 250000, output_modalities: ["text"] }],
      codexHome,
      activate: true,
    });
    const catalog = JSON.parse(
      await fs.readFile(path.join(codexHome, "omniroute-model-catalog.json"), "utf8")
    );
    const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    const catalogStats = await fs.stat(path.join(codexHome, "omniroute-model-catalog.json"));

    assert.equal(result.activated, true);
    assert.equal(catalog.models.length, 3);
    assert.match(config, new RegExp(`model_catalog_json = ${JSON.stringify(result.catalogPath)}`));
    assert.equal(catalogStats.mode & 0o777, 0o600);
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("captureCodexNativeCatalog runs the installed Codex bundled-catalog command", () => {
  const catalog = captureCodexNativeCatalog("codex", (binary, args) => {
    assert.equal(binary, "codex");
    assert.deepEqual(args, ["debug", "models", "--bundled"]);
    return { status: 0, stdout: JSON.stringify(nativeCatalog), stderr: "" };
  });

  assert.equal(catalog.models.length, 2);
});
