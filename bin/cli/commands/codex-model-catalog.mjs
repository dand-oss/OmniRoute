import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  categoriseModel,
  fallbackCodexProfile,
  isCodexCompatibleTextModel,
} from "./setup-codex.mjs";

export const CODEX_MODEL_CATALOG_FILENAME = "omniroute-model-catalog.json";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function clone(value) {
  return structuredClone(value);
}

function rewriteCodexIdentity(value, displayName) {
  if (typeof value !== "string" || !value.includes("based on ")) return value;
  return value.replace(
    /You are Codex, an? (?:\w+ )?agent based on [^.]+\./,
    () => `You are Codex, an agent based on ${displayName}.`
  );
}

function selectNativeTemplate(models) {
  return (
    models.find((model) => model.slug === "gpt-5.5") ||
    models.find(
      (model) =>
        model.visibility === "list" &&
        typeof model.base_instructions === "string" &&
        model.base_instructions.trim()
    ) ||
    models.find(
      (model) => typeof model.base_instructions === "string" && model.base_instructions.trim()
    )
  );
}

function nativeModelList(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const valid = models.filter(
    (model) =>
      model &&
      typeof model === "object" &&
      !Array.isArray(model) &&
      nonEmptyString(model.slug) &&
      typeof model.base_instructions === "string" &&
      model.base_instructions.trim()
  );
  if (valid.length === 0) {
    throw new Error("The Codex native catalog has no usable model templates.");
  }
  return valid;
}

function reasoningLevels(model, configuredEffort, template) {
  const capabilities = asRecord(model.capabilities);
  const templateDescriptions = new Map(
    (Array.isArray(template.supported_reasoning_levels) ? template.supported_reasoning_levels : [])
      .map((level) => {
        const record = asRecord(level);
        const effort = nonEmptyString(record.effort);
        const description = nonEmptyString(record.description);
        return effort && description ? [effort, description] : null;
      })
      .filter(Boolean)
  );
  const fallbackDescriptions = {
    minimal: "Minimal reasoning for quick responses",
    low: "Fast reasoning for simple edits",
    medium: "Balanced reasoning for everyday coding",
    high: "Deep reasoning with thinking enabled",
    xhigh: "Extra-deep reasoning for complex work",
    max: "Maximum reasoning supported by this model",
    ultra: "Highest reasoning supported by this model",
  };
  const declared = Array.isArray(capabilities.effort_tiers)
    ? capabilities.effort_tiers.filter(
        (effort) =>
          effort === "minimal" ||
          effort === "low" ||
          effort === "medium" ||
          effort === "high" ||
          effort === "xhigh" ||
          effort === "max" ||
          effort === "ultra"
      )
    : [];
  const efforts = declared.length > 0 ? declared : configuredEffort ? [configuredEffort] : [];
  return efforts.map((effort) => ({
    effort,
    description:
      templateDescriptions.get(effort) || fallbackDescriptions[effort] || `${effort} reasoning`,
  }));
}

function inputModalities(model) {
  const declared = Array.isArray(model.input_modalities)
    ? model.input_modalities.map((item) => String(item).toLowerCase()).filter(Boolean)
    : [];
  if (declared.length > 0) return declared;
  return ["text"];
}

function displayPriority(nativeModels) {
  const visible = nativeModels.filter((model) => model.visibility !== "hide");
  const priorities = (visible.length > 0 ? visible : nativeModels)
    .map((model) => Number(model.priority))
    .filter((value) => Number.isFinite(value));
  return (priorities.length > 0 ? Math.max(...priorities) : 0) + 1;
}

function buildExternalModel(template, model, cfg, priority) {
  const id = typeof model === "string" ? model : String(model.id ?? "");
  const record = typeof model === "string" ? {} : asRecord(model);
  const displayName = nonEmptyString(record.name) || id;
  const levels = reasoningLevels(record, cfg.effort, template);
  const context = cfg.ctx;
  const next = clone(template);
  const modelMessages = asRecord(next.model_messages);

  next.slug = id;
  next.display_name = displayName;
  next.description = nonEmptyString(record.description) || "Routed through OmniRoute.";
  next.priority = priority;
  next.visibility = "list";
  next.supported_in_api = true;
  next.context_window = context;
  next.max_context_window = positiveNumber(record.max_context_window) || context;
  next.auto_compact_token_limit = cfg.compact;
  next.effective_context_window_percent = 95;
  next.input_modalities = inputModalities(record);
  next.additional_speed_tiers = [];
  next.service_tiers = [];
  next.default_service_tier = null;
  next.availability_nux = null;
  next.upgrade = null;
  next.supports_reasoning_summaries = false;
  next.default_reasoning_summary = "none";
  next.support_verbosity = false;
  next.default_verbosity = null;
  next.supports_search_tool = false;
  next.supports_image_detail_original = false;
  next.supports_parallel_tool_calls = false;
  next.use_responses_lite = false;
  next.prefer_websockets = false;
  next.experimental_supported_tools = [];
  next.multi_agent_version = "v1";
  next.base_instructions = rewriteCodexIdentity(template.base_instructions, displayName);

  if (levels.length > 0) {
    next.supported_reasoning_levels = levels;
    next.default_reasoning_level = cfg.effort || levels[0].effort;
  } else {
    next.supported_reasoning_levels = [];
    delete next.default_reasoning_level;
  }

  if (modelMessages.instructions_template) {
    modelMessages.instructions_template = rewriteCodexIdentity(
      modelMessages.instructions_template,
      displayName
    );
    next.model_messages = modelMessages;
  }

  delete next.minimal_client_version;
  delete next.tool_mode;
  return next;
}

export function buildCodexModelCatalog(nativeCatalog, omnirouteModels) {
  const nativeModels = nativeModelList(nativeCatalog);
  const template = selectNativeTemplate(nativeModels);
  const models = new Map(nativeModels.map((model) => [String(model.slug), clone(model)]));
  let priority = displayPriority(nativeModels);
  let added = 0;
  let skipped = 0;

  for (const model of omnirouteModels) {
    const id = typeof model === "string" ? model : String(model?.id ?? "");
    if (!id || !isCodexCompatibleTextModel(model) || models.has(id)) {
      skipped++;
      continue;
    }

    const cfg = categoriseModel(id) ?? fallbackCodexProfile(id, model);
    if (!cfg) {
      skipped++;
      continue;
    }

    models.set(id, buildExternalModel(template, model, cfg, priority));
    priority++;
    added++;
  }

  return { models: [...models.values()], added, skipped };
}

export function captureCodexNativeCatalog(
  binary = process.env.CLI_CODEX_BIN || "codex",
  run = spawnSync
) {
  const result = run(binary, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(
      `Codex native catalog capture failed with exit code ${result.status}${stderr ? `: ${stderr}` : ""}`
    );
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("Codex native catalog capture did not return valid JSON.");
  }
  nativeModelList(payload);
  return payload;
}

function atomicWrite(target, contents, mode) {
  mkdirSync(join(target, ".."), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode });
  renameSync(temporary, target);
}

export function setCodexModelCatalogConfig(contents, catalogPath) {
  if (contents.trim()) parseToml(contents);
  const targetAssignment = `model_catalog_json = ${JSON.stringify(catalogPath)}`;
  const lines = contents.split("\n");
  const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootLimit = firstSection === -1 ? lines.length : firstSection;
  const assignment = /^\s*model_catalog_json\s*=/;

  for (let index = 0; index < rootLimit; index++) {
    if (!assignment.test(lines[index])) continue;
    if (lines[index].includes(JSON.stringify(catalogPath))) return contents;
    throw new Error(
      `Refusing to replace an existing model_catalog_json setting: ${lines[index].trim()}`
    );
  }

  const insertion = firstSection === -1 ? lines.length : firstSection;
  const next = [...lines];
  next.splice(insertion, 0, targetAssignment);
  return `${next
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

export async function syncCodexModelCatalog({
  nativeCatalog,
  models,
  codexHome,
  activate = false,
  dryRun = false,
}) {
  const catalogPath = join(codexHome, CODEX_MODEL_CATALOG_FILENAME);
  const catalog = buildCodexModelCatalog(nativeCatalog, models);

  if (dryRun) {
    return { ...catalog, catalogPath, activated: false, dryRun: true };
  }

  let activated = false;
  let configPath = null;
  let nextConfig = null;
  if (activate) {
    configPath = join(codexHome, "config.toml");
    const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    nextConfig = setCodexModelCatalogConfig(existing, catalogPath);
    activated = true;
  }

  mkdirSync(codexHome, { recursive: true });
  atomicWrite(catalogPath, `${JSON.stringify({ models: catalog.models }, null, 2)}\n`, 0o600);
  if (configPath && nextConfig !== null) {
    atomicWrite(configPath, nextConfig, 0o600);
    activated = true;
  }

  return { ...catalog, catalogPath, activated, dryRun: false };
}
