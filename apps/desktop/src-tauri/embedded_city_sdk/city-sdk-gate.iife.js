"use strict";
(() => {
  // packages/agent-vitals-city-sdk/dist/index.js
  var IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
  var ANCHOR_KINDS = /* @__PURE__ */ new Set(["spawn", "route", "zone", "object"]);
  var CAPABILITIES = /* @__PURE__ */ new Set(["drive", "walk", "fly"]);
  var MAX_PACK_JSON_BYTES = 256 * 1024;
  function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
  }
  var hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function id(value) {
    return typeof value === "string" && IDENTIFIER.test(value);
  }
  function integer(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
  }
  function diagnostic(code, path, message, objectId) {
    return { code, severity: "error", path, message, ...objectId ? { objectId } : {} };
  }
  function validateMiniGamePack(value) {
    const diagnostics = [];
    if (!object(value)) return { ok: false, diagnostics: [diagnostic("content_invalid_shape", "$", "Mini-game pack must be a JSON object.")] };
    if (!hasOnlyKeys(value, ["schemaVersion", "id", "rulesVersion", "slots", "integerParameters", "rules"])) diagnostics.push(diagnostic("content_field_unsupported", "$", "Mini-game pack contains unsupported fields."));
    if (value.schemaVersion !== 1 || value.rulesVersion !== 1) diagnostics.push(diagnostic("schema_unsupported", "$", "Only mini-game schema and rules version 1 are supported."));
    if (!id(value.id)) diagnostics.push(diagnostic("content_invalid_id", "id", "Pack ID must be a stable ASCII identifier."));
    if (!object(value.slots)) diagnostics.push(diagnostic("content_invalid_shape", "slots", "Slots must be an object."));
    const slots = object(value.slots) ? value.slots : {};
    if (Object.keys(slots).length > 32) diagnostics.push(diagnostic("content_budget_exceeded", "slots", "A pack may declare at most 32 slots."));
    for (const [name, raw] of Object.entries(slots)) {
      const path = `slots.${name}`;
      if (!id(name) || !object(raw)) {
        diagnostics.push(diagnostic("content_invalid_slot", path, "Slot must have a stable ID and object definition."));
        continue;
      }
      if (!hasOnlyKeys(raw, ["kind", "min", "max", "requires"])) diagnostics.push(diagnostic("content_field_unsupported", path, "Slot contains unsupported fields."));
      if (typeof raw.kind !== "string" || !ANCHOR_KINDS.has(raw.kind)) diagnostics.push(diagnostic("content_invalid_slot", `${path}.kind`, "Slot kind is unsupported."));
      if (!integer(raw.min, 0, 64) || !integer(raw.max, 0, 64) || integer(raw.min, 0, 64) && integer(raw.max, 0, 64) && raw.min > raw.max) diagnostics.push(diagnostic("content_invalid_slot", path, "Slot min/max must be integers from 0 to 64, with min no greater than max."));
      if (raw.requires !== void 0 && (!Array.isArray(raw.requires) || raw.requires.some((capability) => typeof capability !== "string" || !CAPABILITIES.has(capability)))) diagnostics.push(diagnostic("content_invalid_slot", `${path}.requires`, "Slot capabilities must be drive, walk or fly."));
    }
    let parameters = {};
    if (value.integerParameters !== void 0) {
      if (!object(value.integerParameters)) diagnostics.push(diagnostic("content_invalid_parameter", "integerParameters", "Integer parameters must be an object."));
      else parameters = value.integerParameters;
    }
    if (Object.keys(parameters).length > 32) diagnostics.push(diagnostic("content_budget_exceeded", "integerParameters", "A pack may declare at most 32 integer parameters."));
    for (const [name, raw] of Object.entries(parameters)) {
      if (!id(name) || !object(raw) || !hasOnlyKeys(raw, ["min", "max", "default"]) || !integer(raw.min, 0, 1e6) || !integer(raw.max, 0, 1e6) || !integer(raw.default, 0, 1e6) || raw.min > raw.max || raw.default < raw.min || raw.default > raw.max) {
        diagnostics.push(diagnostic("content_invalid_parameter", `integerParameters.${name}`, "Parameter bounds/default must be ordered integers between 0 and 1,000,000."));
      }
    }
    if (!object(value.rules)) diagnostics.push(diagnostic("rule_invalid_shape", "rules", "Rules must be an object."));
    const rules = object(value.rules) ? value.rules : {};
    if (!hasOnlyKeys(rules, ["counters", "nodes"])) diagnostics.push(diagnostic("content_field_unsupported", "rules", "Rules contain unsupported fields."));
    if (!object(rules.counters)) diagnostics.push(diagnostic("rule_invalid_counter", "rules.counters", "Counters must be an object."));
    const counters = object(rules.counters) ? rules.counters : {};
    if (Object.keys(counters).length > 32) diagnostics.push(diagnostic("rule_budget_exceeded", "rules.counters", "A rule graph may declare at most 32 counters."));
    for (const [name, raw] of Object.entries(counters)) {
      if (!id(name) || !object(raw) || !hasOnlyKeys(raw, ["initial", "max"]) || !integer(raw.initial, 0, 1e9)) {
        diagnostics.push(diagnostic("rule_invalid_counter", `rules.counters.${name}`, "Counter bounds must be non-negative integers; initial must not exceed max."));
        continue;
      }
      const maxIsParameter = object(raw.max) && hasOnlyKeys(raw.max, ["parameter"]) && id(raw.max.parameter) && hasOwn(parameters, raw.max.parameter);
      const maxLiteral = typeof raw.max === "number" ? raw.max : null;
      if (!maxIsParameter && (maxLiteral === null || maxLiteral < 0 || maxLiteral > 1e9 || raw.initial > maxLiteral)) diagnostics.push(diagnostic("rule_invalid_counter", `rules.counters.${name}`, "Counter max must be a bounded integer (initial not exceeding it) or a declared parameter reference."));
    }
    if (!Array.isArray(rules.nodes)) diagnostics.push(diagnostic("rule_invalid_shape", "rules.nodes", "Rule nodes must be an array."));
    const nodes = Array.isArray(rules.nodes) ? rules.nodes : [];
    if (nodes.length > 128) diagnostics.push(diagnostic("rule_budget_exceeded", "rules.nodes", "A rule graph may declare at most 128 nodes."));
    const nodeIds = /* @__PURE__ */ new Set();
    for (let index = 0; index < nodes.length; index += 1) {
      const path = `rules.nodes[${index}]`, raw = nodes[index];
      if (!object(raw) || !id(raw.id)) {
        diagnostics.push(diagnostic("rule_invalid_node", path, "Rule node must have an object body and stable ID."));
        continue;
      }
      if (!hasOnlyKeys(raw, ["id", "on", "when", "actions"])) diagnostics.push(diagnostic("content_field_unsupported", path, "Rule node contains unsupported fields.", raw.id));
      if (nodeIds.has(raw.id)) diagnostics.push(diagnostic("rule_duplicate_node_id", `${path}.id`, "Rule node IDs must be unique.", raw.id));
      nodeIds.add(raw.id);
      const event = raw.on;
      let eventValid = false;
      if (object(event)) {
        if (event.type === "run.started" && !hasOnlyKeys(event, ["type"])) diagnostics.push(diagnostic("rule_invalid_event", `${path}.on`, "run.started event has unsupported fields.", raw.id));
        if (event.type === "run.started") eventValid = true;
        else if (event.type === "zone.entered" || event.type === "item.collected") {
          if (!hasOnlyKeys(event, ["type", "slot"])) diagnostics.push(diagnostic("rule_invalid_event", `${path}.on`, "Player input event has unsupported fields.", raw.id));
          const slotId = event.slot;
          eventValid = id(slotId) && hasOwn(slots, slotId);
          if (!eventValid) diagnostics.push(diagnostic("rule_slot_not_found", `${path}.on.slot`, "Rule references an undeclared slot.", raw.id));
          else if (event.type === "zone.entered" && typeof slotId === "string" && object(slots[slotId]) && slots[slotId].kind !== "zone") diagnostics.push(diagnostic("rule_slot_kind_mismatch", `${path}.on.slot`, "zone.entered rules require a zone slot.", raw.id));
        } else if (event.type === "timer.expired") {
          eventValid = id(event.timerId);
          if (!hasOnlyKeys(event, ["type", "timerId"])) diagnostics.push(diagnostic("rule_invalid_event", `${path}.on`, "Timer event has unsupported fields.", raw.id));
        }
      }
      if (!eventValid) diagnostics.push(diagnostic("rule_invalid_event", `${path}.on`, "Rule event type or required event fields are invalid.", raw.id));
      if (raw.when !== void 0 && (!Array.isArray(raw.when) || raw.when.length > 8)) diagnostics.push(diagnostic("rule_budget_exceeded", `${path}.when`, "A rule may contain at most 8 guards.", raw.id));
      if (Array.isArray(raw.when)) for (const [guardIndex, guard] of raw.when.entries()) {
        if (!object(guard) || !id(guard.counter) || !hasOwn(counters, guard.counter) || guard.op === "counter.eq" && !(integer(guard.value, 0, 1e9) || object(guard.value) && hasOnlyKeys(guard.value, ["parameter"]) && id(guard.value.parameter) && hasOwn(parameters, guard.value.parameter)) || guard.op !== "counter.eq" && guard.op !== "counter.eqEventIndex") diagnostics.push(diagnostic("rule_invalid_guard", `${path}.when[${guardIndex}]`, "Guard operation or counter reference is invalid.", raw.id));
        if (object(guard) && guard.op === "counter.eqEventIndex" && object(event) && event.type !== "zone.entered" && event.type !== "item.collected") diagnostics.push(diagnostic("rule_invalid_guard", `${path}.when[${guardIndex}]`, "counter.eqEventIndex requires a player input event.", raw.id));
      }
      if (!Array.isArray(raw.actions) || raw.actions.length > 16) diagnostics.push(diagnostic("rule_budget_exceeded", `${path}.actions`, "A rule must contain at most 16 actions.", raw.id));
      if (Array.isArray(raw.actions)) for (const [actionIndex, action] of raw.actions.entries()) {
        const actionPath = `${path}.actions[${actionIndex}]`;
        if (!object(action) || typeof action.op !== "string") {
          diagnostics.push(diagnostic("rule_invalid_action", actionPath, "Action must be an object with an operation.", raw.id));
          continue;
        }
        if (action.op === "counter.add") {
          if (!hasOnlyKeys(action, ["op", "counter", "amount"])) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "counter.add contains unsupported fields.", raw.id));
          if (!id(action.counter) || !hasOwn(counters, action.counter) || !integer(action.amount, -1e6, 1e6)) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "counter.add requires a declared counter and bounded integer amount.", raw.id));
        } else if (action.op === "timer.start") {
          if (!hasOnlyKeys(action, ["op", "timerId", "durationTicks"])) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "timer.start contains unsupported fields.", raw.id));
          const durationValid = typeof action.durationTicks === "number" ? integer(action.durationTicks, 1, 1e6) : object(action.durationTicks) && hasOnlyKeys(action.durationTicks, ["parameter"]) && id(action.durationTicks.parameter) && hasOwn(parameters, action.durationTicks.parameter);
          if (!id(action.timerId) || !durationValid) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "timer.start requires a stable timer ID and bounded duration.", raw.id));
        } else if (action.op === "hud.hint") {
          if (!hasOnlyKeys(action, ["op", "text"])) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "hud.hint contains unsupported fields.", raw.id));
          if (typeof action.text !== "string" || action.text.length > 160) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "HUD hint must be text no longer than 160 characters.", raw.id));
        } else if (action.op === "run.finish") {
          if (!hasOnlyKeys(action, ["op", "outcome"])) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "run.finish contains unsupported fields.", raw.id));
          if (action.outcome !== "success" && action.outcome !== "failure") diagnostics.push(diagnostic("rule_invalid_action", actionPath, "run.finish outcome must be success or failure.", raw.id));
        } else diagnostics.push(diagnostic("rule_operation_unsupported", actionPath, "Action operation is not supported by the safe version 1 runtime.", raw.id));
      }
    }
    if (diagnostics.length) return { ok: false, diagnostics };
    const snapshot = {
      schemaVersion: 1,
      id: value.id,
      rulesVersion: 1,
      slots: Object.fromEntries(Object.entries(slots).map(([name, raw]) => {
        const slot = raw;
        return [name, {
          kind: slot.kind,
          min: slot.min,
          max: slot.max,
          ...Array.isArray(slot.requires) ? { requires: [...slot.requires] } : {}
        }];
      })),
      ...Object.keys(parameters).length ? { integerParameters: Object.fromEntries(Object.entries(parameters).map(([name, raw]) => {
        const parameter = raw;
        return [name, { min: parameter.min, max: parameter.max, default: parameter.default }];
      })) } : {},
      rules: {
        counters: Object.fromEntries(Object.entries(counters).map(([name, raw]) => {
          const counter = raw;
          return [name, { initial: counter.initial, max: counter.max }];
        })),
        nodes: nodes.map((raw) => {
          const node = raw;
          const event = node.on;
          return {
            id: node.id,
            on: event.type === "run.started" ? { type: "run.started" } : event.type === "timer.expired" ? { type: "timer.expired", timerId: event.timerId } : { type: event.type, slot: event.slot },
            ...Array.isArray(node.when) ? { when: node.when.map((guard) => ({ ...guard })) } : {},
            actions: node.actions.map((action) => {
              const copied = { ...action };
              if (object(copied.durationTicks)) copied.durationTicks = { ...copied.durationTicks };
              return copied;
            })
          };
        })
      }
    };
    const freeze = (item) => {
      if (item && typeof item === "object" && !Object.isFrozen(item)) {
        for (const child of Object.values(item)) freeze(child);
        Object.freeze(item);
      }
      return item;
    };
    return { ok: true, value: freeze(snapshot), diagnostics };
  }
  var MAX_PACKAGE_FILES = 128;
  var MAX_JSON_FILE_BYTES = 10 * 1024 * 1024;
  var MAX_BINARY_FILE_BYTES = 64 * 1024 * 1024;
  var MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
  var MAX_PACKAGE_JSON_BYTES = 140 * 1024 * 1024;
  var object2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  function canonicalJson(value) {
    const encode = (item, path, ancestors) => {
      if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
      if (typeof item === "number") {
        if (!Number.isFinite(item)) throw new TypeError(`${path} contains a non-finite number.`);
        return JSON.stringify(item);
      }
      if (Array.isArray(item)) {
        if (ancestors.has(item)) throw new TypeError(`${path} contains a cycle.`);
        if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).some((key) => {
          if (key === "length") return false;
          const index = Number(key);
          return !Number.isSafeInteger(index) || index < 0 || index >= item.length || String(index) !== key;
        })) {
          throw new TypeError(`${path} contains non-JSON array properties.`);
        }
        ancestors.add(item);
        const entries = Array.from({ length: item.length }, (_, index) => {
          if (!Object.prototype.hasOwnProperty.call(item, index)) throw new TypeError(`${path}[${index}] is missing.`);
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${path}[${index}] must be a data property.`);
          return encode(item[index], `${path}[${index}]`, ancestors);
        });
        const encoded = `[${entries.join(",")}]`;
        ancestors.delete(item);
        return encoded;
      }
      if (object2(item)) {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain JSON object.`);
        if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).length !== Object.keys(item).length) {
          throw new TypeError(`${path} contains non-JSON object properties.`);
        }
        if (ancestors.has(item)) throw new TypeError(`${path} contains a cycle.`);
        ancestors.add(item);
        const keys2 = Object.keys(item).sort();
        const encoded = `{${keys2.map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${path}.${key} must be a data property.`);
          const entry = item[key];
          if (entry === void 0 || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
            throw new TypeError(`${path}.${key} is not a JSON value.`);
          }
          return `${JSON.stringify(key)}:${encode(entry, `${path}.${key}`, ancestors)}`;
        }).join(",")}}`;
        ancestors.delete(item);
        return encoded;
      }
      throw new TypeError(`${path} is not a JSON value.`);
    };
    return encode(value, "$", /* @__PURE__ */ new Set());
  }
  var PACKAGE_V1_LIMITS = Object.freeze({
    maxFiles: MAX_PACKAGE_FILES,
    maxJsonFileBytes: MAX_JSON_FILE_BYTES,
    maxBinaryFileBytes: MAX_BINARY_FILE_BYTES,
    maxPackageBytes: MAX_PACKAGE_BYTES,
    maxPackageJsonBytes: MAX_PACKAGE_JSON_BYTES
  });
  var obj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  var only = (v, allowed) => Object.keys(v).every((k) => allowed.includes(k));
  var id2 = (v) => typeof v === "string" && /^[a-zA-Z0-9-][a-zA-Z0-9._:/-]{0,127}$/.test(v);
  var num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  var integer2 = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  var point = (v, height = false) => obj(v) && Object.keys(v).length === (height ? 3 : 2) && only(v, height ? ["x", "z", "h"] : ["x", "z"]) && num(v.x, -1e6, 1e6) && num(v.z, -1e6, 1e6) && (!height || num(v.h, -1e6, 1e6));
  var optionalPoint = (v, k) => v[k] === void 0 || point(v[k]);
  var text = (v) => typeof v === "string" && new TextEncoder().encode(v).length <= 128 && v.length > 0 && !/\p{Cc}/u.test(v);
  var invalid = (code, message) => ({ ok: false, diagnostics: [{ code, severity: "error", path: "patch", message }] });
  function validateWorldPlanPatch(input, seed, generatorVersion) {
    let raw, value;
    try {
      raw = canonicalJson(input);
      if (new TextEncoder().encode(raw).length > 262144) return invalid("world_patch_budget_exceeded", "Patch exceeds 256 KiB.");
      value = JSON.parse(raw);
    } catch {
      return invalid("world_patch_invalid", "Patch must be finite plain JSON.");
    }
    if (!integer2(seed, 0, 4294967295) || !integer2(generatorVersion, 1, 1024) || !obj(value) || !only(value, ["version", "seed", "scaleTier", "generatorVersion", "islandRadius", "updatedAt", "roadOps", "highwayOps", "siteOps", "buildingMoves", "moveAnchors", "suppressedContext", "terrainOps"]) || value.version !== 1 || value.seed !== seed || (value.generatorVersion ?? 1) !== generatorVersion || !integer2(value.scaleTier, 0, 1024) || !integer2(value.updatedAt, 0, Number.MAX_SAFE_INTEGER) || value.islandRadius !== void 0 && !num(value.islandRadius, Number.MIN_VALUE, 1e5)) return invalid("world_patch_scope_invalid", "Patch shape, seed or generator version is invalid.");
    if (!obj(value.buildingMoves) || Object.keys(value.buildingMoves).length !== 0 || value.moveAnchors !== void 0 && (!obj(value.moveAnchors) || Object.keys(value.moveAnchors).length !== 0))
      return invalid("world_patch_private_buildings", "Portable packages cannot contain session-building IDs or moves.");
    if (!Array.isArray(value.suppressedContext) || value.suppressedContext.length > 4096 || !value.suppressedContext.every(id2)) return invalid("world_patch_invalid", "Invalid suppressed context.");
    if (!Array.isArray(value.roadOps) || value.roadOps.length > 4096) return invalid("world_patch_invalid", "Invalid road operations.");
    for (const op of value.roadOps) {
      if (!obj(op)) return invalid("world_patch_invalid", "Invalid road operation.");
      const purpose = op.purpose === void 0 || op.purpose === "waterfront";
      const width = num(op.width, Number.MIN_VALUE, 64);
      const valid = op.t === "add" ? only(op, ["t", "from", "to", "width", "purpose", "via"]) && point(op.from) && point(op.to) && width && purpose && optionalPoint(op, "via") : op.t === "drop" ? only(op, ["t", "edge", "anchor"]) && id2(op.edge) && optionalPoint(op, "anchor") : op.t === "move" ? only(op, ["t", "node", "to", "anchor"]) && id2(op.node) && point(op.to) && optionalPoint(op, "anchor") : op.t === "restyle" ? only(op, ["t", "edge", "width", "purpose", "anchor"]) && id2(op.edge) && width && purpose && optionalPoint(op, "anchor") : false;
      if (!valid) return invalid("world_patch_invalid", "Invalid road operation.");
    }
    if (!Array.isArray(value.siteOps) || value.siteOps.length > 4096) return invalid("world_patch_invalid", "Invalid site operations.");
    for (const op of value.siteOps) {
      if (!obj(op) || !id2(op.id) || !optionalPoint(op, "at") || op.cls !== void 0 && !text(op.cls)) return invalid("world_patch_invalid", "Invalid site operation.");
      const valid = op.t === "remove" ? only(op, ["t", "id", "at", "cls"]) : op.t === "move" && only(op, ["t", "id", "at", "to", "toAnchor", "cls"]) && text(op.to) && optionalPoint(op, "toAnchor");
      if (!valid) return invalid("world_patch_invalid", "Invalid site operation.");
    }
    if (value.highwayOps !== void 0) {
      if (!Array.isArray(value.highwayOps) || value.highwayOps.length > 1024) return invalid("world_patch_invalid", "Invalid highway operations.");
      for (const op of value.highwayOps) if (!obj(op) || !(op.t === "cut" ? only(op, ["t", "at"]) && point(op.at) : op.t === "add" && only(op, ["t", "points"]) && Array.isArray(op.points) && op.points.length >= 2 && op.points.length <= 256 && op.points.every((p) => point(p)))) return invalid("world_patch_invalid", "Invalid highway operation.");
    }
    if (value.terrainOps !== void 0) {
      if (!Array.isArray(value.terrainOps) || value.terrainOps.length > 64) return invalid("world_patch_invalid", "Invalid terrain operations.");
      for (const op of value.terrainOps) if (!obj(op) || !(op.t === "pad" ? only(op, ["t", "at", "radius", "falloff", "height"]) && point(op.at) && num(op.radius, 0, 40) && num(op.falloff, 4, 30) && num(op.height, -1e6, 1e6) : op.t === "ramp" && only(op, ["t", "from", "to", "width", "falloff"]) && point(op.from, true) && point(op.to, true) && num(op.width, 2, 24) && num(op.falloff, 4, 30))) return invalid("world_patch_invalid", "Invalid terrain operation.");
    }
    return { ok: true, value: Object.freeze(value), diagnostics: [] };
  }
  var WORLD_PARAMETER_LIMITS = Object.freeze({
    maxParameters: 32,
    maxPresets: 16,
    maxEnumValues: 8,
    maxUnitLength: 16,
    maxLabelLength: 64
  });
  var error = (code, path, message) => ({ code, severity: "error", path, message });
  var object3 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var finite = (value) => typeof value === "number" && Number.isFinite(value);
  var parameterByKey = (capability) => {
    const map = /* @__PURE__ */ new Map();
    for (const descriptor of capability.parameters) map.set(`${descriptor.group}.${descriptor.id}`, descriptor);
    return map;
  };
  function validateWorldParametersV1(capability, input) {
    if (!object3(capability)) return { ok: false, diagnostics: [error("world_params_invalid", "", "Capability must be an object.")] };
    if (!object3(input)) return { ok: false, diagnostics: [error("world_params_invalid", "", "Parameters must be an object.")] };
    const keys2 = Object.keys(input);
    if (keys2.length > WORLD_PARAMETER_LIMITS.maxParameters) {
      return { ok: false, diagnostics: [error("world_params_budget_exceeded", "", `At most ${WORLD_PARAMETER_LIMITS.maxParameters} parameters per set.`)] };
    }
    const byKey = parameterByKey(capability);
    const merged = {};
    for (const descriptor of capability.parameters) merged[`${descriptor.group}.${descriptor.id}`] = descriptor.default;
    for (const key of keys2) {
      const descriptor = byKey.get(key);
      if (!descriptor) return { ok: false, diagnostics: [error("world_params_unknown", key, "Unknown world parameter for this generator.")] };
      const value = input[key];
      if (descriptor.kind === "enum") {
        if (typeof value !== "string" || !descriptor.values?.includes(value)) {
          return { ok: false, diagnostics: [error("world_params_out_of_range", key, `Value must be one of ${(descriptor.values ?? []).join("/")}.`)] };
        }
      } else if (!finite(value)) {
        return { ok: false, diagnostics: [error("world_params_invalid", key, "Value must be a finite number.")] };
      } else if (descriptor.kind === "integer" ? !Number.isSafeInteger(value) : false) {
        return { ok: false, diagnostics: [error("world_params_invalid", key, "Value must be a safe integer.")] };
      } else if (value < descriptor.min || value > descriptor.max) {
        return { ok: false, diagnostics: [error("world_params_out_of_range", key, `Value must be within ${descriptor.min}..${descriptor.max}.`)] };
      }
      merged[key] = value;
    }
    return { ok: true, diagnostics: [], value: Object.freeze(merged) };
  }
  var ARID_DUNES_WORLD_V2 = Object.freeze({
    generatorId: "arid-dunes-v1",
    contractVersion: 2,
    parameters: Object.freeze([
      Object.freeze({ group: "landform", id: "duneScale", kind: "number", min: 96, max: 600, default: 190, unit: "m" }),
      Object.freeze({ group: "landform", id: "duneAmplitude", kind: "number", min: 1, max: 36, default: 11, unit: "m" }),
      Object.freeze({ group: "landform", id: "orientationDeg", kind: "number", min: -180, max: 180, default: 18, unit: "deg" }),
      Object.freeze({ group: "shape", id: "family", kind: "enum", values: ["disc", "lobed", "dumbbell", "coastal"], default: "disc" }),
      Object.freeze({ group: "shape", id: "cores", kind: "integer", min: 1, max: 3, default: 1 }),
      Object.freeze({ group: "shape", id: "aspectRatio", kind: "number", min: 1, max: 1.8, default: 1 }),
      Object.freeze({ group: "shape", id: "corridorPull", kind: "number", min: 0, max: 0.4, default: 0 }),
      Object.freeze({ group: "shape", id: "coastFractal", kind: "number", min: 0, max: 0.25, default: 0.035 }),
      Object.freeze({ group: "shape", id: "radiusClass", kind: "enum", values: ["small", "medium", "large"], default: "medium" }),
      Object.freeze({ group: "landform", id: "duneFrequency", kind: "number", min: 0.5, max: 2, default: 1 }),
      Object.freeze({ group: "landform", id: "ridgeSecondary", kind: "number", min: 0, max: 1, default: 0 }),
      Object.freeze({ group: "water", id: "oasisCount", kind: "integer", min: 0, max: 3, default: 0 }),
      Object.freeze({ group: "water", id: "lakeCount", kind: "integer", min: 0, max: 3, default: 0 }),
      Object.freeze({ group: "water", id: "lakeSizeM", kind: "number", min: 40, max: 400, default: 120, unit: "m" }),
      Object.freeze({ group: "vegetation", id: "greenbeltWidth", kind: "number", min: 0, max: 80, default: 0, unit: "m" }),
      Object.freeze({ group: "vegetation", id: "forestPatchiness", kind: "number", min: 0, max: 1, default: 0 }),
      Object.freeze({ group: "landscape", id: "rockOutcropDensity", kind: "number", min: 0, max: 1, default: 0 }),
      Object.freeze({ group: "landscape", id: "riverMeander", kind: "number", min: 0, max: 1, default: 0 }),
      Object.freeze({ group: "landscape", id: "riverWidthM", kind: "number", min: 10, max: 60, default: 40, unit: "m" }),
      Object.freeze({ group: "landscape", id: "ridgeCount", kind: "integer", min: 0, max: 3, default: 0 }),
      Object.freeze({ group: "landscape", id: "ridgeHeightM", kind: "number", min: 20, max: 120, default: 60, unit: "m" }),
      Object.freeze({ group: "skeleton", id: "ringCount", kind: "integer", min: 1, max: 3, default: 2 })
    ]),
    presets: Object.freeze([
      Object.freeze({ id: "disc", label: "\u5706\u76D8\u6C99\u6D77\uFF08\u73B0\u884C\u9ED8\u8BA4\uFF09", parameters: Object.freeze({}) }),
      Object.freeze({ id: "lobed", label: "\u591A\u74E3\u6C99\u6D77", parameters: Object.freeze({ "shape.family": "lobed", "shape.cores": 3 }) }),
      Object.freeze({ id: "dumbbell", label: "\u53CC\u6838\u54D1\u94C3", parameters: Object.freeze({ "shape.family": "dumbbell", "shape.cores": 2, "shape.corridorPull": 0.2 }) }),
      Object.freeze({ id: "coastal", label: "\u6C99\u6D77\u5CB8\u7EBF", parameters: Object.freeze({ "shape.family": "coastal", "shape.coastFractal": 0.18 }) })
    ])
  });
  var COASTAL_ISLANDS_WORLD_V1 = Object.freeze({
    generatorId: "coastal-islands-v1",
    contractVersion: 1,
    parameters: Object.freeze([
      Object.freeze({ group: "shape", id: "bayHalfWidth", kind: "number", min: 0.1, max: 0.5, default: 0.22 }),
      Object.freeze({ group: "shape", id: "bayShift", kind: "number", min: -0.5, max: 0.5, default: 0.33 })
    ]),
    presets: Object.freeze([
      Object.freeze({ id: "vice-bay", label: "Vice City \u6D77\u6E7E\uFF08\u73B0\u884C\u9ED8\u8BA4\uFF09", parameters: Object.freeze({}) })
    ])
  });
  var ARID_DUNES_LEGACY_KEYS = Object.freeze(["landform.duneScale", "landform.duneAmplitude", "landform.orientationDeg"]);
  var error2 = (code, path, message, objectId) => ({ code, severity: "error", path, message, ...objectId ? { objectId } : {} });
  var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var identifier2 = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
  var exactKeys2 = (value, keys2) => Object.keys(value).every((key) => keys2.includes(key));
  var hasOwn2 = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  var ANCHOR_KINDS2 = /* @__PURE__ */ new Set(["spawn", "route", "zone", "object"]);
  var CAPABILITIES2 = /* @__PURE__ */ new Set(["drive", "walk", "fly"]);
  var MAX_LAYOUT_ANCHORS = 2e4;
  var MAX_LAYOUT_LINKS = 1e5;
  function validateCityInstance(value) {
    if (!isObject(value) || !exactKeys2(value, ["schemaVersion", "cityId", "revision", "name", "seed", "profile", "planPatch"])) {
      return { ok: false, diagnostics: [error2("city_instance_invalid_shape", "$", "City must contain only the version 1 instance fields.")] };
    }
    if (value.schemaVersion !== 1 || typeof value.cityId !== "string" || !identifier2.test(value.cityId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.name !== "string" || value.name.trim() !== value.name || [...value.name].length < 1 || [...value.name].length > 120 || /\p{Cc}/u.test(value.name) || !Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 4294967295) {
      return { ok: false, diagnostics: [error2("city_instance_invalid_identity", "$", "City identity, name, revision or seed is invalid.")] };
    }
    const profile = validateCityWorldProfile(value.profile);
    if (!profile.ok) return { ok: false, diagnostics: profile.diagnostics.map((item) => ({ ...item, path: `profile.${item.path}` })) };
    let planPatch;
    if (value.planPatch !== void 0) {
      const version = isObject(value.planPatch) ? value.planPatch.generatorVersion ?? 1 : 0;
      const checked = validateWorldPlanPatch(value.planPatch, value.seed, version);
      if (!checked.ok) return checked;
      planPatch = checked.value;
    }
    return { ok: true, value: Object.freeze({
      schemaVersion: 1,
      cityId: value.cityId,
      revision: value.revision,
      name: value.name,
      seed: value.seed,
      profile: profile.value,
      ...planPatch ? { planPatch } : {}
    }), diagnostics: [] };
  }
  function validateCityWorldProfile(value) {
    if (!isObject(value) || !exactKeys2(value, ["schemaVersion", "id", "version", "biome", "geography", "visuals"])) {
      return { ok: false, diagnostics: [error2("world_profile_invalid_shape", "$", "World profile must contain only the version 1 world fields.")] };
    }
    if (value.schemaVersion !== 1 || typeof value.id !== "string" || !identifier2.test(value.id) || !Number.isSafeInteger(value.version) || value.version < 1) {
      return { ok: false, diagnostics: [error2("world_profile_invalid_identity", "$", "World profile requires a stable ID and positive integer version.")] };
    }
    if (!isObject(value.geography) || !exactKeys2(value.geography, ["generator", "parameters"]) || !isObject(value.geography.parameters)) {
      return { ok: false, diagnostics: [error2("world_profile_invalid_geography", "geography", "Geography must declare a supported generator and its parameters.")] };
    }
    if (!isObject(value.visuals) || !exactKeys2(value.visuals, ["themeId"]) || value.visuals.themeId !== "miami" && value.visuals.themeId !== "desert") {
      return { ok: false, diagnostics: [error2("world_profile_invalid_visuals", "visuals", "World profile must reference a registered City visual theme.")] };
    }
    let profile;
    if (value.geography.generator === "arid-dunes-v1") {
      const parameters = value.geography.parameters;
      if (value.biome !== "arid" || !isObject(parameters) || !hasOwn2(parameters, "dunes") || Object.keys(parameters).some((key) => key !== "dunes" && key !== "diversity") || !isObject(parameters.dunes) || !exactKeys2(parameters.dunes, ["duneScale", "duneAmplitude", "orientationDeg"])) {
        return { ok: false, diagnostics: [error2("world_profile_invalid_parameters", "geography.parameters", "Arid dune profiles require the version 1 dune parameters and an optional diversity record.")] };
      }
      const dunes = parameters.dunes;
      if (typeof dunes.duneScale !== "number" || !Number.isFinite(dunes.duneScale) || dunes.duneScale < 96 || dunes.duneScale > 600 || typeof dunes.duneAmplitude !== "number" || !Number.isFinite(dunes.duneAmplitude) || dunes.duneAmplitude < 1 || dunes.duneAmplitude > 36 || typeof dunes.orientationDeg !== "number" || !Number.isFinite(dunes.orientationDeg) || dunes.orientationDeg < -180 || dunes.orientationDeg > 180) {
        return { ok: false, diagnostics: [error2("world_profile_parameter_out_of_range", "geography.parameters.dunes", "Dune parameters are outside the generator's supported bounds.")] };
      }
      let diversity;
      if (parameters.diversity !== void 0) {
        if (!isObject(parameters.diversity)) {
          return { ok: false, diagnostics: [error2("world_profile_invalid_parameters", "geography.parameters.diversity", "Diversity parameters must be an object of capability-keyed values.")] };
        }
        if (Object.keys(parameters.diversity).some((key) => ARID_DUNES_LEGACY_KEYS.includes(key))) {
          return { ok: false, diagnostics: [error2("world_profile_invalid_parameters", "geography.parameters.diversity", "Diversity must not restate the version 1 dune parameters.")] };
        }
        const checked = validateWorldParametersV1(ARID_DUNES_WORLD_V2, parameters.diversity);
        if (!checked.ok) {
          return { ok: false, diagnostics: checked.diagnostics.map((item) => error2(item.code, `geography.parameters.diversity.${item.path}`, item.message)) };
        }
        diversity = Object.freeze(Object.fromEntries(Object.entries(parameters.diversity).map(([key, val]) => [key, val])));
      }
      profile = {
        schemaVersion: 1,
        id: value.id,
        version: value.version,
        biome: "arid",
        geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: dunes.duneScale, duneAmplitude: dunes.duneAmplitude, orientationDeg: dunes.orientationDeg }, ...diversity ? { diversity } : {} } },
        visuals: { themeId: value.visuals.themeId }
      };
    } else if (value.geography.generator === "coastal-islands-v1") {
      const parameters = value.geography.parameters;
      if (value.biome !== "tropical" || !exactKeys2(parameters, ["coastal"]) || !isObject(parameters.coastal)) {
        return { ok: false, diagnostics: [error2("world_profile_invalid_parameters", "geography.parameters", "Coastal island profiles require a coastal parameter object and tropical biome.")] };
      }
      const coastal = parameters.coastal;
      const coastalKeys = ["profile", "version", "biome", "preferredAzimuth", "azimuthTolerance", "segmentArc", "wetSandWidth", "drySandWidth", "promenadeOffset", "boulevardOffset", "hotelOffset", "bandOuter", "maxCoastalSlope", "maxCoastalHeight", "riverMargin", "siteMargin", "minValidRatio", "bayHalfWidth", "bayShift"];
      if (!exactKeys2(coastal, coastalKeys) || coastal.profile !== "miami-coastal" || coastal.biome !== "tropical" || !Number.isSafeInteger(coastal.version) || coastal.version < 1) {
        return { ok: false, diagnostics: [error2("world_profile_invalid_parameters", "geography.parameters.coastal", "Coastal profile identity or fields are invalid.")] };
      }
      const bounds = {
        preferredAzimuth: [-Math.PI * 2, Math.PI * 2],
        azimuthTolerance: [0, Math.PI],
        segmentArc: [0.01, Math.PI * 2],
        wetSandWidth: [0, 500],
        drySandWidth: [0, 500],
        promenadeOffset: [0, 500],
        boulevardOffset: [0, 500],
        hotelOffset: [0, 500],
        bandOuter: [0, 500],
        maxCoastalSlope: [0, 10],
        maxCoastalHeight: [0, 100],
        riverMargin: [0, 500],
        siteMargin: [0, 500],
        minValidRatio: [0, 1],
        bayHalfWidth: [0, 0.5],
        bayShift: [-1, 1]
      };
      for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
        const number2 = coastal[key];
        if (typeof number2 !== "number" || !Number.isFinite(number2) || number2 < minimum || number2 > maximum) {
          return { ok: false, diagnostics: [error2("world_profile_parameter_out_of_range", `geography.parameters.coastal.${key}`, "Coastal parameter is outside its supported bounds.")] };
        }
      }
      const number = (key) => coastal[key];
      if (!(number("wetSandWidth") <= number("drySandWidth") && number("drySandWidth") <= number("promenadeOffset") && number("promenadeOffset") <= number("boulevardOffset") && number("boulevardOffset") <= number("hotelOffset") && number("hotelOffset") <= number("bandOuter"))) {
        return { ok: false, diagnostics: [error2("world_profile_parameter_order_invalid", "geography.parameters.coastal", "Coastal offsets must progress from shoreline to inland in order.")] };
      }
      const coastalSnapshot = Object.freeze(Object.fromEntries(coastalKeys.map((key) => [key, coastal[key]])));
      profile = {
        schemaVersion: 1,
        id: value.id,
        version: value.version,
        biome: "tropical",
        geography: { generator: "coastal-islands-v1", parameters: Object.freeze({ coastal: coastalSnapshot }) },
        visuals: { themeId: value.visuals.themeId }
      };
    } else {
      return { ok: false, diagnostics: [error2("world_profile_generator_unsupported", "geography.generator", "The requested City geography generator is not registered.")] };
    }
    if (profile.geography.generator === "arid-dunes-v1") {
      Object.freeze(profile.geography.parameters.dunes);
      if (profile.geography.parameters.diversity) Object.freeze(profile.geography.parameters.diversity);
    }
    Object.freeze(profile.geography.parameters);
    Object.freeze(profile.geography);
    Object.freeze(profile.visuals);
    return { ok: true, value: Object.freeze(profile), diagnostics: [] };
  }
  function validateCityLayout(value) {
    if (!isObject(value) || !exactKeys2(value, ["schemaVersion", "id", "coordinateSystem", "anchors", "links"])) {
      return { ok: false, diagnostics: [error2("layout_invalid_shape", "$", "Layout must contain only version 1 layout fields.")] };
    }
    if (value.schemaVersion !== 1) return { ok: false, diagnostics: [error2("schema_unsupported", "schemaVersion", "Only City layout schema version 1 is supported.")] };
    if (typeof value.id !== "string" || !identifier2.test(value.id)) return { ok: false, diagnostics: [error2("layout_invalid_id", "id", "Layout ID must be a stable identifier.")] };
    if (value.coordinateSystem !== "city-local-m-v1") return { ok: false, diagnostics: [error2("layout_coordinate_system_unsupported", "coordinateSystem", "Only city-local-m-v1 coordinates are supported.")] };
    if (!Array.isArray(value.anchors)) return { ok: false, diagnostics: [error2("layout_invalid_anchors", "anchors", "Layout anchors must be an array.")] };
    if (value.anchors.length > MAX_LAYOUT_ANCHORS) return { ok: false, diagnostics: [error2("layout_budget_exceeded", "anchors", `A layout may expose at most ${MAX_LAYOUT_ANCHORS} anchors.`)] };
    const diagnostics = [];
    const seen = /* @__PURE__ */ new Set();
    const anchors = [];
    for (const [index, raw] of value.anchors.entries()) {
      const path = `anchors[${index}]`;
      if (!isObject(raw) || !exactKeys2(raw, ["id", "kind", "capabilities", "geometryRef"])) {
        diagnostics.push(error2("layout_invalid_anchor", path, "Anchor must contain only id, kind, capabilities and geometryRef."));
        continue;
      }
      if (typeof raw.id !== "string" || !identifier2.test(raw.id)) diagnostics.push(error2("layout_invalid_anchor_id", `${path}.id`, "Anchor ID must be a stable identifier."));
      else if (seen.has(raw.id)) diagnostics.push(error2("layout_duplicate_anchor_id", `${path}.id`, "Anchor IDs must be unique within a layout.", raw.id));
      else seen.add(raw.id);
      if (typeof raw.kind !== "string" || !ANCHOR_KINDS2.has(raw.kind)) diagnostics.push(error2("layout_invalid_anchor_kind", `${path}.kind`, "Anchor kind is unsupported."));
      if (!Array.isArray(raw.capabilities) || raw.capabilities.length > CAPABILITIES2.size || raw.capabilities.some((item) => typeof item !== "string" || !CAPABILITIES2.has(item)) || Array.isArray(raw.capabilities) && new Set(raw.capabilities).size !== raw.capabilities.length) {
        diagnostics.push(error2("layout_invalid_anchor_capabilities", `${path}.capabilities`, "Capabilities must be unique drive/walk/fly values."));
      }
      if (typeof raw.geometryRef !== "string" || !identifier2.test(raw.geometryRef)) diagnostics.push(error2("layout_invalid_geometry_ref", `${path}.geometryRef`, "Geometry reference must be a stable identifier."));
      if (typeof raw.id === "string" && identifier2.test(raw.id) && typeof raw.kind === "string" && ANCHOR_KINDS2.has(raw.kind) && Array.isArray(raw.capabilities) && raw.capabilities.every((item) => typeof item === "string" && CAPABILITIES2.has(item)) && typeof raw.geometryRef === "string" && identifier2.test(raw.geometryRef)) {
        anchors.push({ id: raw.id, kind: raw.kind, capabilities: [...raw.capabilities], geometryRef: raw.geometryRef });
      }
    }
    const links = [];
    if (value.links !== void 0) {
      if (!Array.isArray(value.links)) diagnostics.push(error2("layout_invalid_links", "links", "Layout links must be an array when provided."));
      else if (value.links.length > MAX_LAYOUT_LINKS) diagnostics.push(error2("layout_budget_exceeded", "links", `A layout may expose at most ${MAX_LAYOUT_LINKS} links.`));
      else {
        const linkIds = /* @__PURE__ */ new Set();
        const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
        for (const [index, raw] of value.links.entries()) {
          const path = `links[${index}]`;
          if (!isObject(raw) || !exactKeys2(raw, ["id", "fromAnchorId", "toAnchorId", "capabilities"])) {
            diagnostics.push(error2("layout_invalid_link", path, "Link must contain only id, endpoint IDs and capabilities."));
            continue;
          }
          const idOk = typeof raw.id === "string" && identifier2.test(raw.id);
          if (!idOk) diagnostics.push(error2("layout_invalid_link_id", `${path}.id`, "Link ID must be a stable identifier."));
          else if (linkIds.has(raw.id)) diagnostics.push(error2("layout_duplicate_link_id", `${path}.id`, "Link IDs must be unique within a layout.", raw.id));
          else linkIds.add(raw.id);
          const fromOk = typeof raw.fromAnchorId === "string" && identifier2.test(raw.fromAnchorId);
          const toOk = typeof raw.toAnchorId === "string" && identifier2.test(raw.toAnchorId);
          if (!fromOk || !toOk || raw.fromAnchorId === raw.toAnchorId) diagnostics.push(error2("layout_invalid_link_endpoint", path, "Link endpoints must be distinct stable anchor IDs."));
          const from = fromOk ? anchorsById.get(raw.fromAnchorId) : void 0;
          const to = toOk ? anchorsById.get(raw.toAnchorId) : void 0;
          if (!from) diagnostics.push(error2("layout_link_anchor_not_found", `${path}.fromAnchorId`, "Link source anchor does not exist.", fromOk ? raw.fromAnchorId : void 0));
          if (!to) diagnostics.push(error2("layout_link_anchor_not_found", `${path}.toAnchorId`, "Link destination anchor does not exist.", toOk ? raw.toAnchorId : void 0));
          if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0 || raw.capabilities.length > CAPABILITIES2.size || raw.capabilities.some((item) => typeof item !== "string" || !CAPABILITIES2.has(item)) || Array.isArray(raw.capabilities) && new Set(raw.capabilities).size !== raw.capabilities.length) {
            diagnostics.push(error2("layout_invalid_link_capabilities", `${path}.capabilities`, "Links require unique drive/walk/fly traversal capabilities."));
            continue;
          }
          for (const capability of raw.capabilities) {
            if (from && !from.capabilities.includes(capability)) diagnostics.push(error2("layout_link_capability_missing", `${path}.capabilities`, `Source anchor does not support ${capability}.`, from.id));
            if (to && !to.capabilities.includes(capability)) diagnostics.push(error2("layout_link_capability_missing", `${path}.capabilities`, `Destination anchor does not support ${capability}.`, to.id));
          }
          if (idOk && from && to && Array.isArray(raw.capabilities) && raw.capabilities.length > 0 && raw.capabilities.every((item) => typeof item === "string" && CAPABILITIES2.has(item))) {
            links.push({ id: raw.id, fromAnchorId: from.id, toAnchorId: to.id, capabilities: [...raw.capabilities] });
          }
        }
      }
    }
    if (diagnostics.length) return { ok: false, diagnostics };
    return { ok: true, value: Object.freeze({ schemaVersion: 1, id: value.id, coordinateSystem: "city-local-m-v1", anchors: Object.freeze(anchors.map((anchor) => Object.freeze({ ...anchor, capabilities: Object.freeze([...anchor.capabilities]) }))), ...value.links === void 0 ? {} : { links: Object.freeze(links.map((link) => Object.freeze({ ...link, capabilities: Object.freeze([...link.capabilities]) }))) } }), diagnostics: [] };
  }
  function validateSceneDraft(value) {
    if (!isObject(value) || !exactKeys2(value, ["schemaVersion", "objects"]) || value.schemaVersion !== 1 || !Array.isArray(value.objects)) {
      return { ok: false, diagnostics: [error2("scene_invalid_shape", "$", "Scene draft must be a version 1 object with an objects array.")] };
    }
    if (value.objects.length > 1e4) return { ok: false, diagnostics: [error2("scene_budget_exceeded", "objects", "Scene draft may contain at most 10000 objects.")] };
    const diagnostics = [];
    const objects = [];
    const ids = /* @__PURE__ */ new Set();
    let colliderCount = 0;
    const validVector = (raw, bounds) => isObject(raw) && exactKeys2(raw, ["x", "y", "z"]) && [raw.x, raw.y, raw.z].every((number) => typeof number === "number" && Number.isFinite(number) && number >= bounds[0] && number <= bounds[1]);
    const validRef = (raw) => isObject(raw) && exactKeys2(raw, ["package", "assetId", "digest"]) && isObject(raw.package) && exactKeys2(raw.package, ["kind", "id", "version", "digest"]) && typeof raw.package.kind === "string" && ["city-layout", "city-skin", "city-minigame", "city-world"].includes(raw.package.kind) && typeof raw.package.id === "string" && identifier2.test(raw.package.id) && typeof raw.package.version === "string" && raw.package.version.length > 0 && raw.package.version.length <= 64 && typeof raw.package.digest === "string" && raw.package.digest.length > 0 && raw.package.digest.length <= 256 && typeof raw.assetId === "string" && identifier2.test(raw.assetId) && typeof raw.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(raw.digest);
    for (const [index, raw] of value.objects.entries()) {
      const path = `objects[${index}]`;
      if (!isObject(raw) || typeof raw.id !== "string" || !identifier2.test(raw.id)) {
        diagnostics.push(error2("scene_object_invalid", path, "Scene object must have a stable ID."));
        continue;
      }
      if (ids.has(raw.id)) diagnostics.push(error2("scene_object_duplicate_id", `${path}.id`, "Scene object IDs must be unique.", raw.id));
      ids.add(raw.id);
      if (!isObject(raw.transform) || !exactKeys2(raw.transform, ["positionMeters", "rotationRadians", "scale"]) || !validVector(raw.transform.positionMeters, [-1e5, 1e5]) || !validVector(raw.transform.rotationRadians, [-6283, 6283]) || !validVector(raw.transform.scale, [1e-3, 100])) {
        diagnostics.push(error2("scene_transform_invalid", `${path}.transform`, "Transform must use bounded meter position, radian rotation and positive scale vectors.", raw.id));
        continue;
      }
      const transform = Object.freeze({ positionMeters: Object.freeze({ ...raw.transform.positionMeters }), rotationRadians: Object.freeze({ ...raw.transform.rotationRadians }), scale: Object.freeze({ ...raw.transform.scale }) });
      if (raw.kind === "model" && exactKeys2(raw, ["id", "kind", "asset", "transform"])) {
        if (!validRef(raw.asset)) diagnostics.push(error2("scene_asset_ref_invalid", `${path}.asset`, "Model asset reference is invalid.", raw.id));
        else objects.push(Object.freeze({ id: raw.id, kind: "model", asset: Object.freeze({ package: Object.freeze({ ...raw.asset.package }), assetId: raw.asset.assetId, digest: raw.asset.digest }), transform }));
      } else if (raw.kind === "collider" && exactKeys2(raw, ["id", "kind", "shape", "sizeMeters", "transform"])) {
        colliderCount += 1;
        if (colliderCount > 256) diagnostics.push(error2("scene_collider_budget_exceeded", "objects", "A scene draft may contain at most 256 static box colliders.", raw.id));
        if (raw.shape !== "box" || !validVector(raw.sizeMeters, [0.1, 100])) {
          diagnostics.push(error2("scene_collider_invalid", `${path}.shape`, "Static collider must be a bounded box with meter dimensions between 0.1 and 100.", raw.id));
        } else if (colliderCount <= 256) objects.push(Object.freeze({
          id: raw.id,
          kind: "collider",
          shape: "box",
          sizeMeters: Object.freeze({ ...raw.sizeMeters }),
          transform
        }));
      } else if (raw.kind === "anchor" && exactKeys2(raw, ["id", "kind", "anchor", "transform"])) {
        if (!isObject(raw.anchor) || raw.anchor.id !== raw.id) {
          diagnostics.push(error2("scene_anchor_id_mismatch", `${path}.anchor.id`, "Scene anchor and object IDs must match.", raw.id));
          continue;
        }
        const layout = validateCityLayout({ schemaVersion: 1, id: "scene-anchor-check", coordinateSystem: "city-local-m-v1", anchors: [raw.anchor] });
        if (!layout.ok) diagnostics.push(...layout.diagnostics.map((item) => ({ ...item, path: `${path}.anchor.${item.path.replace(/^anchors\[0\]\.*/, "")}`, objectId: raw.id })));
        else objects.push(Object.freeze({ id: raw.id, kind: "anchor", anchor: layout.value.anchors[0], transform }));
      } else diagnostics.push(error2("scene_object_invalid", path, "Scene object kind or fields are unsupported.", raw.id));
    }
    if (diagnostics.length) return { ok: false, diagnostics };
    return { ok: true, value: Object.freeze({ schemaVersion: 1, objects: Object.freeze(objects) }), diagnostics: [] };
  }
  var CREATOR_CAPABILITY_SCHEMA_VERSION = 1;
  var CREATOR_CAPABILITY_VERSION = "2026-11-17.1";
  var CREATOR_OPERATIONS_V1 = Object.freeze([
    { id: "scene.object.upsert", kind: "upsert", target: "scene.objects", idField: "id" },
    { id: "scene.object.remove", kind: "remove", target: "scene.objects", idField: "id" },
    { id: "anchor.upsert", kind: "upsert", target: "scene.objects", idField: "id" },
    { id: "anchor.remove", kind: "remove", target: "scene.objects", idField: "id" },
    { id: "mount.bind", kind: "bind", target: "mounts", idField: "mountId" },
    { id: "mount.remove", kind: "remove", target: "mounts", idField: "mountId" },
    { id: "skin.select", kind: "set", target: "skinId" },
    { id: "city.patch.upsert", kind: "set", target: "cityPatch" },
    { id: "city.patch.remove", kind: "remove", target: "cityPatch" }
  ]);
  var CREATOR_CONTENT_V1 = Object.freeze({
    templates: ["checkpoint-race", "flight-checkpoint", "ornithopter-flight", "collect-one"],
    skins: ["miami-vice", "desert-evening"]
  });
  var CREATOR_BUDGETS_V1 = Object.freeze({
    gameBytes: 262144,
    sceneObjects: 1e4,
    sceneColliders: 256,
    mountBindings: 32,
    cityPatchBytes: 262144
  });
  var CREATOR_LIMITS_V1 = Object.freeze({
    sceneObjectKinds: ["model", "anchor", "collider"],
    maxOperationsPerPreview: 128,
    maxReleaseMounts: 32,
    maxImportedModelBytes: 64 * 1024 * 1024,
    maxProjectAssets: 4096,
    playtestTtlMs: 30 * 60 * 1e3,
    maxProjectBytes: 2 * 1024 * 1024,
    maxReleaseBytes: 512 * 1024,
    previewTtlMs: 6e5,
    maxActivePreviews: 128
  });
  var CREATOR_WORLD_BUDGETS_V1 = Object.freeze({
    maxOperationsPerPreview: 16,
    maxParametersPerSet: 32,
    maxRequestBytes: 8 * 1024
  });
  var CREATOR_WORLDS_V1 = Object.freeze({
    schemaVersion: 1,
    capabilityVersion: CREATOR_CAPABILITY_VERSION,
    budgets: CREATOR_WORLD_BUDGETS_V1,
    generators: Object.freeze({
      "arid-dunes-v1": Object.freeze({
        contractVersion: ARID_DUNES_WORLD_V2.contractVersion,
        parameters: ARID_DUNES_WORLD_V2.parameters,
        presets: ARID_DUNES_WORLD_V2.presets
      }),
      "coastal-islands-v1": Object.freeze({
        contractVersion: COASTAL_ISLANDS_WORLD_V1.contractVersion,
        parameters: COASTAL_ISLANDS_WORLD_V1.parameters,
        presets: COASTAL_ISLANDS_WORLD_V1.presets
      })
    })
  });
  var CREATOR_GAME_TYPES_V1 = Object.freeze([
    {
      id: "miami.flight-v1",
      label: "\u9A7E\u9A76\u98DE\u673A",
      template: "miami-flight",
      templateCatalog: "builtin",
      runtime: { id: "miami.flight", contractVersion: 1 },
      status: "builtin-adapter"
    },
    {
      id: "miami.driving-v1",
      label: "\u9A7E\u8F66",
      template: "miami-driving",
      templateCatalog: "builtin",
      runtime: { id: "miami.driving", contractVersion: 1 },
      status: "builtin-adapter"
    },
    {
      id: "miami.mecha-v1",
      label: "\u673A\u7532\u6218\u68CB",
      template: "miami-mecha",
      templateCatalog: "builtin",
      runtime: { id: "miami.mecha", contractVersion: 1 },
      status: "builtin-adapter"
    },
    {
      id: "miami.cinema-v1",
      label: "\u822A\u62CD",
      template: "miami-cinema",
      templateCatalog: "builtin",
      runtime: { id: "miami.cinema", contractVersion: 1 },
      status: "builtin-adapter"
    },
    {
      id: "creator.flight-ornithopter-prototype-v1",
      label: "\u6251\u7FFC\u98DE\u884C\uFF08\u98DE\u884C\u539F\u578B\uFF09",
      template: "miami-flight",
      templateCatalog: "builtin",
      runtime: { id: "miami.flight", contractVersion: 1 },
      status: "prototype"
    },
    {
      id: "creator.flight-ornithopter-v1",
      label: "\u6251\u7FFC\u98DE\u884C",
      template: "ornithopter-flight",
      templateCatalog: "planned",
      runtime: { id: "city-flight-ornithopter", contractVersion: 1 },
      status: "planned"
    }
  ]);
  var CREATOR_CAPABILITIES_PROJECTION_V1 = Object.freeze({
    schemaVersion: 1,
    capabilityVersion: CREATOR_CAPABILITY_VERSION,
    categories: {
      game: { preview: "creator.game.preview", commit: "creator.project.commit", maxGameBytes: CREATOR_BUDGETS_V1.gameBytes },
      scene: {
        preview: "creator.scene.preview",
        commit: "creator.scene.commit",
        objectKinds: CREATOR_LIMITS_V1.sceneObjectKinds,
        maxObjects: CREATOR_BUDGETS_V1.sceneObjects,
        maxColliders: CREATOR_BUDGETS_V1.sceneColliders,
        maxOperationsPerPreview: CREATOR_LIMITS_V1.maxOperationsPerPreview
      },
      mount: { bind: "mount.bind", remove: "mount.remove", maxReleaseMounts: CREATOR_LIMITS_V1.maxReleaseMounts },
      skin: { select: "skin.select", skins: CREATOR_CONTENT_V1.skins },
      cityPatch: { upsert: "city.patch.upsert", remove: "city.patch.remove", maxBytes: CREATOR_BUDGETS_V1.cityPatchBytes },
      assets: {
        import: "creator.asset.import\uFF08\u684C\u9762\u539F\u751F\u9009\u62E9\u5668\uFF0CMCP \u4E0D\u63A5\u6536\u8DEF\u5F84\uFF09",
        maxImportedModelBytes: CREATOR_LIMITS_V1.maxImportedModelBytes,
        maxAssets: CREATOR_LIMITS_V1.maxProjectAssets
      },
      playtest: {
        start: "creator.project.playtest.start",
        result: "creator.project.playtest.result",
        cancel: "creator.project.playtest.cancel",
        ttlMs: CREATOR_LIMITS_V1.playtestTtlMs
      },
      project: {
        create: "creator.project.create",
        publish: "creator.project.publish",
        maxDocumentBytes: CREATOR_LIMITS_V1.maxProjectBytes,
        maxReleaseBytes: CREATOR_LIMITS_V1.maxReleaseBytes,
        templates: CREATOR_CONTENT_V1.templates
      },
      worlds: { operation: "world.set", budgets: CREATOR_WORLD_BUDGETS_V1, generators: CREATOR_WORLDS_V1.generators },
      gameTypes: { status: "adapter-seam", types: CREATOR_GAME_TYPES_V1 }
    },
    preview: { ttlMs: CREATOR_LIMITS_V1.previewTtlMs, maxActive: CREATOR_LIMITS_V1.maxActivePreviews, singleUse: true, instanceBound: true }
  });
  var CREATOR_RECOVERIES_V1 = Object.freeze([
    Object.freeze({ code: "creator_layout_not_ready", tool: "creator_city_view_status", args: {}, note: "\u5E03\u5C40\u5C1A\u672A\u751F\u6210\u5B8C\u6BD5\uFF1B\u8F6E\u8BE2\u72B6\u6001\u76F4\u5230 ready \u540E\u518D\u8BFB\u53D6\u5E03\u5C40\u3002" }),
    Object.freeze({ code: "creator_layout_not_found", tool: "creator_city_view_status", args: {}, note: "\u8BE5\u7248\u672C\u5C1A\u65E0\u5E03\u5C40\uFF1B\u7B49\u5F85\u57CE\u5E02\u89C6\u53E3 ready\uFF08\u5FC5\u8981\u65F6\u7528 creator_city_view \u6253\u5F00\uFF09\uFF0C\u5E03\u5C40\u7531\u89C6\u53E3\u751F\u6210\u540E\u518D\u8BFB\u53D6\u3002" }),
    Object.freeze({ code: "revision_conflict", tool: "creator_project_read", args: {}, note: "\u9879\u76EE\u5DF2\u88AB\u4ED6\u4EBA\u63A8\u8FDB\uFF1B\u91CD\u8BFB\u6700\u65B0 revision \u540E\u4EE5\u65B0\u57FA\u7EBF\u91CD\u5F00\u9884\u89C8\u3002" }),
    Object.freeze({ code: "creator_city_revision_unavailable", tool: "creator_city_read", args: {}, note: "\u8BF7\u6C42\u7684\u5386\u53F2\u7248\u672C\u5DF2\u88AB\u8986\u76D6\uFF1B\u6539\u8BFB\u5F53\u524D revision\u3002" }),
    Object.freeze({ code: "preview_expired", tool: "creator_scene_preview", args: {}, note: "\u9884\u89C8\u5DF2\u8FC7\u671F\uFF1B\u4EE5\u5F53\u524D revision \u91CD\u65B0\u53D1\u8D77\u9884\u89C8\u540E\u518D\u63D0\u4EA4\u3002" }),
    Object.freeze({ code: "operation_id_conflict", tool: "creator_operation_status", args: {}, note: "\u540C\u4E00 operationId \u88AB\u7528\u4E8E\u4E0D\u540C\u8BF7\u6C42\uFF1B\u6362\u65B0 operationId\uFF0C\u6216\u5148\u67E5\u8BE2\u65E2\u6709\u7ED3\u679C\u3002" }),
    Object.freeze({ code: "creator_playtest_not_claimed", tool: "creator_playtest_start", args: {}, note: "\u5C1A\u65E0\u6D3B\u8DC3\u8BD5\u73A9\uFF1B\u5148 start \u4E00\u6B21\u8BD5\u73A9\u518D\u8BFB\u53D6\u7ED3\u679C\u3002" }),
    Object.freeze({ code: "creator_playtest_instance_mismatch", tool: "creator_playtest_start", args: {}, note: "\u8BD5\u73A9\u88AB\u5176\u4ED6\u5B9E\u4F8B\u9886\u53D6\uFF1B\u91CD\u65B0 start \u5F00\u542F\u65B0\u7684\u8BD5\u73A9\u3002" }),
    Object.freeze({ code: "creator_capture_unavailable", tool: "creator_city_view_status", args: {}, note: "\u89C6\u53E3\u4E0D\u53EF\u7528\uFF08\u672A\u6253\u5F00/\u65E0\u5934\uFF09\uFF1B\u7B49\u5F85\u89C6\u53E3 ready\uFF0C\u6216\u6539\u7528\u7ED3\u6784\u6821\u9A8C\u4E0E\u65E0\u5934\u89C4\u5219\u8BD5\u73A9\u3002" }),
    Object.freeze({ code: "creator_validation_scope_mismatch", tool: "creator_project_read", args: {}, note: "\u4FE1\u5C01\u4F5C\u7528\u57DF\u4E0E\u8BF7\u6C42\u4E0D\u7B26\uFF1B\u91CD\u8BFB\u9879\u76EE\u540E\u8BA9 Studio \u91CD\u65B0\u9644\u53D1\u4FE1\u5C01\u3002" })
  ]);
  var CREATOR_SEMANTIC_GATE_V1 = Object.freeze({
    schemaVersion: 1,
    studioEnvelope: true,
    embeddedSdk: true,
    embeddedSdkCoverage: ["vehicle.preview", "vehicle.define", "city.edit.preview(world.set)", "city.edit.commit", "city.create"],
    requiresStudio: [
      "scene.preview",
      "game.preview",
      "city.layout.save",
      "city.anchor.upsert",
      "city.patch.preview",
      "project.create(cityId \u7ED1\u5B9A\u5E03\u5C40)",
      "project.publish",
      "playtest.start",
      "viewport.capture"
    ]
  });
  var CREATOR_CAPABILITIES_V1 = Object.freeze({
    schemaVersion: CREATOR_CAPABILITY_SCHEMA_VERSION,
    capabilityVersion: CREATOR_CAPABILITY_VERSION,
    operations: CREATOR_OPERATIONS_V1,
    content: CREATOR_CONTENT_V1,
    budgets: CREATOR_BUDGETS_V1,
    capabilities: CREATOR_CAPABILITIES_PROJECTION_V1,
    recoveries: CREATOR_RECOVERIES_V1,
    semanticGate: CREATOR_SEMANTIC_GATE_V1
  });
  var CREATOR_TEMPLATES_V1 = Object.freeze([
    {
      id: "checkpoint-race",
      label: "\u9A7E\u9A76\u68C0\u67E5\u70B9\u7ADE\u901F",
      gameType: "driving",
      pack: {
        schemaVersion: 1,
        id: "creator.checkpoint-race",
        rulesVersion: 1,
        slots: { points: { kind: "zone", min: 3, max: 8, requires: ["drive"] } },
        integerParameters: { timeLimitTicks: { min: 60, max: 36e3, default: 2700 }, gateTarget: { min: 3, max: 8, default: 3 } },
        rules: {
          counters: { next: { initial: 0, max: { parameter: "gateTarget" } } },
          nodes: [
            { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "timeout", durationTicks: { parameter: "timeLimitTicks" } }] },
            { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
            { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: { parameter: "gateTarget" } }], actions: [{ op: "run.finish", outcome: "success" }] },
            { id: "timeout", on: { type: "timer.expired", timerId: "timeout" }, actions: [{ op: "run.finish", outcome: "failure" }] }
          ]
        }
      }
    },
    {
      id: "flight-checkpoint",
      label: "\u98DE\u884C\u68C0\u67E5\u70B9",
      gameType: "flight",
      pack: {
        schemaVersion: 1,
        id: "creator.flight-checkpoint",
        rulesVersion: 1,
        slots: { gates: { kind: "zone", min: 3, max: 8, requires: ["fly"] } },
        integerParameters: { timeLimitTicks: { min: 60, max: 36e3, default: 3600 }, gateTarget: { min: 3, max: 8, default: 3 } },
        rules: {
          counters: { next: { initial: 0, max: { parameter: "gateTarget" } } },
          nodes: [
            { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "timeout", durationTicks: { parameter: "timeLimitTicks" } }] },
            { id: "advance", on: { type: "zone.entered", slot: "gates" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
            { id: "finish", on: { type: "zone.entered", slot: "gates" }, when: [{ op: "counter.eq", counter: "next", value: { parameter: "gateTarget" } }], actions: [{ op: "run.finish", outcome: "success" }] },
            { id: "timeout", on: { type: "timer.expired", timerId: "timeout" }, actions: [{ op: "run.finish", outcome: "failure" }] }
          ]
        }
      }
    },
    {
      // 兼容别名（2026-11-15 泛化切片）：`ornithopter-flight` 是扑翼命名检查点模板，
      // 语义上被 preset 驱动的 `flight-checkpoint`（creator.flight-checkpoint）取代；
      // 保留 id 与生成产物，等既有 Creator 工程迁移到 flight-checkpoint 后移除
      // （迁移期间行为不变，rules 与扑翼 preset 解耦，物理来自 VehicleProfileV1）。
      id: "ornithopter-flight",
      label: "\u6251\u7FFC\u98DE\u884C\u68C0\u67E5\u70B9",
      gameType: "flight",
      pack: {
        schemaVersion: 1,
        id: "creator.ornithopter-flight",
        rulesVersion: 1,
        slots: { gates: { kind: "zone", min: 3, max: 8, requires: ["fly"] } },
        integerParameters: {
          timeLimitTicks: { min: 60, max: 36e3, default: 3600 },
          flapPower: { min: 1, max: 10, default: 6 }
        },
        rules: {
          counters: { next: { initial: 0, max: 3 } },
          nodes: [
            { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "timeout", durationTicks: { parameter: "timeLimitTicks" } }] },
            { id: "advance", on: { type: "zone.entered", slot: "gates" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
            { id: "finish", on: { type: "zone.entered", slot: "gates" }, when: [{ op: "counter.eq", counter: "next", value: 3 }], actions: [{ op: "run.finish", outcome: "success" }] },
            { id: "timeout", on: { type: "timer.expired", timerId: "timeout" }, actions: [{ op: "run.finish", outcome: "failure" }] }
          ]
        }
      }
    },
    {
      id: "collect-one",
      label: "\u9A7E\u9A76\u533A\u57DF\u6536\u96C6",
      gameType: "driving",
      pack: {
        schemaVersion: 1,
        id: "creator.collect-one",
        rulesVersion: 1,
        slots: { targets: { kind: "zone", min: 1, max: 1, requires: ["drive"] } },
        integerParameters: {},
        rules: {
          counters: { found: { initial: 0, max: 1 } },
          nodes: [
            { id: "collect", on: { type: "zone.entered", slot: "targets" }, actions: [{ op: "counter.add", counter: "found", amount: 1 }] },
            { id: "finish", on: { type: "zone.entered", slot: "targets" }, when: [{ op: "counter.eq", counter: "found", value: 1 }], actions: [{ op: "run.finish", outcome: "success" }] }
          ]
        }
      }
    }
  ]);
  var MAX_GLB_BYTES = 64 * 1024 * 1024;
  var MAX_FILES = 128;
  var MAX_TOTAL_BYTES = 100 * 1024 * 1024;
  var MAX_JSON_BYTES = 10 * 1024 * 1024;
  var MAX_MEDIA_BYTES = 64 * 1024 * 1024;
  var CONTENT_PACKAGE_V2_LIMITS = Object.freeze({ maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES, maxJsonBytes: MAX_JSON_BYTES, maxMediaBytes: MAX_MEDIA_BYTES });
  var IDENTIFIER4 = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  var LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .·、（）()-]{0,126}$/u;
  var VEHICLE_PROFILE_LIMITS_V1 = Object.freeze({
    maxIdLength: 128,
    maxLabelLength: 128
  });
  var VEHICLE_PHYSICS_BOUNDS_V1 = Object.freeze({
    massKg: [40, 2e4],
    wingAreaM2: [0.5, 400],
    thrustN: [80, 4e5],
    maxSpeedMps: [5, 160],
    dragCoefficient: [0.01, 1.5],
    turnRateRps: [0.15, 2.5],
    climbRateMps: [1, 40],
    sinkRateMps: [0.5, 40],
    flapFrequencyHz: [0.3, 8],
    flapAmplitudeRad: [0.15, 1.6],
    hoverClimbRateMps: [0.5, 30]
  });
  var VEHICLE_CAMERA_BOUNDS_V1 = Object.freeze({
    followDistanceM: [8, 80],
    heightOffsetM: [2, 40],
    fovDeg: [40, 100]
  });
  var VEHICLE_BOUNDS_LIMITS_V1 = Object.freeze({
    halfExtentM: [0.5, 20]
  });
  var VEHICLE_PHYSICS_RATIOS_V1 = Object.freeze({
    minWingLoadingKgPerM2: 1,
    maxWingLoadingKgPerM2: 120,
    minThrustAccelMs2: 1,
    maxThrustAccelMs2: 30
  });
  var VEHICLE_PHYSICS_KEYS_V1 = Object.freeze({
    "fixed-wing": Object.freeze(["massKg", "wingAreaM2", "thrustN", "maxSpeedMps", "dragCoefficient", "turnRateRps", "climbRateMps", "sinkRateMps"]),
    "flapping": Object.freeze(["massKg", "wingAreaM2", "thrustN", "maxSpeedMps", "dragCoefficient", "turnRateRps", "climbRateMps", "sinkRateMps", "flapFrequencyHz", "flapAmplitudeRad"]),
    "vtol": Object.freeze(["massKg", "wingAreaM2", "thrustN", "maxSpeedMps", "dragCoefficient", "turnRateRps", "climbRateMps", "sinkRateMps", "hoverClimbRateMps"])
  });
  var VEHICLE_CAMERA_KEYS_V1 = Object.freeze(["followDistanceM", "heightOffsetM", "fovDeg"]);
  var BOUND_KEYS_V1 = Object.freeze(["halfLengthM", "halfWidthM", "halfHeightM"]);
  var error4 = (code, path, message) => ({ code, severity: "error", path, message });
  var object6 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var finite2 = (value) => typeof value === "number" && Number.isFinite(value);
  function validateVehicleProfileV1(input) {
    const diagnostics = [];
    if (!object6(input)) return { ok: false, diagnostics: [error4("vehicle_profile_invalid", "$", "Vehicle profile must be an object.")] };
    if (!exactKeys4(input, ["schemaVersion", "id", "label", "modelAssetId", "flightModel", "physics", "bounds", "camera"])) {
      diagnostics.push(error4("vehicle_profile_invalid", "$", "Vehicle profile contains missing or unsupported fields."));
    }
    if (input.schemaVersion !== 1) diagnostics.push(error4("vehicle_profile_unsupported", "schemaVersion", "Only vehicle profile schema version 1 is supported."));
    if (typeof input.id !== "string" || !IDENTIFIER4.test(input.id)) diagnostics.push(error4("vehicle_profile_invalid", "id", "Vehicle profile id must be a stable ASCII identifier."));
    if (typeof input.label !== "string" || !LABEL.test(input.label)) diagnostics.push(error4("vehicle_profile_invalid", "label", "Label must be 1..128 characters of plain display text."));
    if (input.modelAssetId !== null && (typeof input.modelAssetId !== "string" || !IDENTIFIER4.test(input.modelAssetId))) {
      diagnostics.push(error4("vehicle_profile_invalid", "modelAssetId", "modelAssetId must be null (procedural placeholder) or a project asset id."));
    }
    let physicsKeys = [];
    if (typeof input.flightModel !== "string" || !VEHICLE_PHYSICS_KEYS_V1.hasOwnProperty(input.flightModel)) {
      diagnostics.push(error4("vehicle_profile_invalid", "flightModel", "flightModel must be fixed-wing, flapping or vtol."));
    } else {
      physicsKeys = VEHICLE_PHYSICS_KEYS_V1[input.flightModel];
    }
    const physics = validateNumberRecord(input.physics, physicsKeys, VEHICLE_PHYSICS_BOUNDS_V1, "physics", diagnostics);
    const camera = validateNumberRecord(input.camera, VEHICLE_CAMERA_KEYS_V1, VEHICLE_CAMERA_BOUNDS_V1, "camera", diagnostics);
    let bounds = null;
    if (!object6(input.bounds) || !exactKeys4(input.bounds, BOUND_KEYS_V1)) {
      diagnostics.push(error4("vehicle_profile_invalid", "bounds", "Bounds must declare exactly halfLengthM, halfWidthM, halfHeightM."));
    } else {
      const half = {};
      for (const key of BOUND_KEYS_V1) {
        const value = input.bounds[key];
        const [min, max] = VEHICLE_BOUNDS_LIMITS_V1.halfExtentM;
        if (!finite2(value) || value < min || value > max) {
          diagnostics.push(error4("vehicle_profile_out_of_bounds", `bounds.${key}`, `Half extent must be a finite number in [${min}, ${max}] m.`));
        } else {
          half[key] = value;
        }
      }
      if (Object.keys(half).length === BOUND_KEYS_V1.length) bounds = Object.freeze(half);
    }
    if (physics) validateRatios(physics, diagnostics);
    if (diagnostics.length || !physics || !camera || !bounds) return { ok: false, diagnostics };
    return {
      ok: true,
      diagnostics: [],
      value: deepFreeze2({
        schemaVersion: 1,
        id: input.id,
        label: input.label,
        modelAssetId: input.modelAssetId,
        flightModel: input.flightModel,
        physics,
        bounds,
        camera
      })
    };
  }
  function validateRatios(physics, diagnostics) {
    const loading = physics.massKg / physics.wingAreaM2;
    if (!Number.isFinite(loading) || loading < VEHICLE_PHYSICS_RATIOS_V1.minWingLoadingKgPerM2 || loading > VEHICLE_PHYSICS_RATIOS_V1.maxWingLoadingKgPerM2) {
      diagnostics.push(error4(
        "vehicle_profile_unphysical",
        "physics.wingAreaM2",
        `Wing loading ${loading.toFixed(3)} kg/m\xB2 is outside [${VEHICLE_PHYSICS_RATIOS_V1.minWingLoadingKgPerM2}, ${VEHICLE_PHYSICS_RATIOS_V1.maxWingLoadingKgPerM2}].`
      ));
    }
    const accel = physics.thrustN / physics.massKg;
    if (!Number.isFinite(accel) || accel < VEHICLE_PHYSICS_RATIOS_V1.minThrustAccelMs2 || accel > VEHICLE_PHYSICS_RATIOS_V1.maxThrustAccelMs2) {
      diagnostics.push(error4(
        "vehicle_profile_unphysical",
        "physics.thrustN",
        `Thrust-to-mass ${accel.toFixed(3)} m/s\xB2 is outside [${VEHICLE_PHYSICS_RATIOS_V1.minThrustAccelMs2}, ${VEHICLE_PHYSICS_RATIOS_V1.maxThrustAccelMs2}].`
      ));
    }
  }
  function validateNumberRecord(raw, allowed, bounds, path, diagnostics) {
    if (!object6(raw)) {
      diagnostics.push(error4("vehicle_profile_invalid", path, `${path} must be an object of finite numbers.`));
      return null;
    }
    if (allowed.length === 0 || !exactKeys4(raw, allowed)) {
      diagnostics.push(error4(
        "vehicle_profile_invalid",
        path,
        `${path} must declare exactly [${allowed.length ? allowed.join(", ") : "keys matching a supported flight model"}].`
      ));
      return null;
    }
    const output = {};
    for (const key of allowed) {
      const value = raw[key];
      if (typeof value !== "number") {
        diagnostics.push(error4("vehicle_profile_invalid", `${path}.${key}`, "Must be a number (strings and objects are rejected; no injection surface)."));
        continue;
      }
      const [min, max] = bounds[key];
      if (!Number.isFinite(value) || value < min || value > max) {
        diagnostics.push(error4("vehicle_profile_out_of_bounds", `${path}.${key}`, `Must be a finite number in [${min}, ${max}].`));
        continue;
      }
      output[key] = value;
    }
    if (Object.keys(output).length !== allowed.length) return null;
    return Object.freeze(output);
  }
  function exactKeys4(value, allowed) {
    const keys2 = Object.keys(value);
    return keys2.length === allowed.length && keys2.every((key) => allowed.includes(key));
  }
  function deepFreeze2(value) {
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) deepFreeze2(item);
      Object.freeze(value);
    }
    return value;
  }
  var VEHICLE_CAMERA_DEFAULTS_V1 = Object.freeze({
    followDistanceFactor: 6.5,
    followDistanceMinM: 8,
    followDistanceMaxM: 80,
    heightOffsetFactor: 2.6,
    heightOffsetMinM: 2,
    heightOffsetMaxM: 40,
    fovDeg: 55
  });
  var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function defaultVehicleCameraV1(bounds) {
    const maxHalf = Math.max(bounds.halfLengthM, bounds.halfWidthM, bounds.halfHeightM);
    return Object.freeze({
      followDistanceM: clamp(maxHalf * VEHICLE_CAMERA_DEFAULTS_V1.followDistanceFactor, VEHICLE_CAMERA_DEFAULTS_V1.followDistanceMinM, VEHICLE_CAMERA_DEFAULTS_V1.followDistanceMaxM),
      heightOffsetM: clamp(maxHalf * VEHICLE_CAMERA_DEFAULTS_V1.heightOffsetFactor, VEHICLE_CAMERA_DEFAULTS_V1.heightOffsetMinM, VEHICLE_CAMERA_DEFAULTS_V1.heightOffsetMaxM),
      fovDeg: VEHICLE_CAMERA_DEFAULTS_V1.fovDeg
    });
  }
  var ORNITHOPTER_VEHICLE_PRESET_V1 = Object.freeze({
    schemaVersion: 1,
    id: "vehicle.ornithopter",
    label: "\u6251\u7FFC\u673A",
    modelAssetId: null,
    flightModel: "flapping",
    physics: Object.freeze({
      massKg: 340,
      wingAreaM2: 18,
      thrustN: 1e4,
      maxSpeedMps: 120,
      dragCoefficient: 0.1,
      turnRateRps: 0.9,
      climbRateMps: 34,
      sinkRateMps: 26,
      flapFrequencyHz: 2.4,
      flapAmplitudeRad: 1.1
    }),
    bounds: Object.freeze({ halfLengthM: 3.6, halfWidthM: 4.8, halfHeightM: 1.4 }),
    camera: Object.freeze({ followDistanceM: 26, heightOffsetM: 12, fovDeg: 52 })
  });
  var FIXED_WING_VEHICLE_PRESET_V1 = Object.freeze({
    schemaVersion: 1,
    id: "vehicle.fixed-wing-light",
    label: "\u56FA\u5B9A\u7FFC\u8F7B\u578B\u673A",
    modelAssetId: null,
    flightModel: "fixed-wing",
    physics: Object.freeze({
      massKg: 620,
      wingAreaM2: 16,
      thrustN: 9e3,
      maxSpeedMps: 130,
      dragCoefficient: 0.06,
      turnRateRps: 1.05,
      climbRateMps: 26,
      sinkRateMps: 20
    }),
    bounds: Object.freeze({ halfLengthM: 4.5, halfWidthM: 5.5, halfHeightM: 1.5 }),
    camera: Object.freeze({ followDistanceM: 30, heightOffsetM: 13, fovDeg: 55 })
  });
  var VEHICLE_PERFORMANCE_DERIVATION_V1 = Object.freeze({ cruiseSpeedDivisor: 1.8 });
  function estimateVehiclePerformanceV1(profile) {
    const physics = profile.physics;
    return Object.freeze({
      cruiseSpeedMps: physics.maxSpeedMps / VEHICLE_PERFORMANCE_DERIVATION_V1.cruiseSpeedDivisor,
      maxSpeedMps: physics.maxSpeedMps,
      thrustAccelMs2: physics.thrustN / physics.massKg,
      wingLoadingKgPerM2: physics.massKg / physics.wingAreaM2,
      turnRateRps: physics.turnRateRps,
      climbRateMps: physics.climbRateMps,
      flapFrequencyHz: profile.flightModel === "flapping" ? physics.flapFrequencyHz ?? 0 : null
    });
  }
  var CREATOR_VEHICLE_CATALOG_V1 = Object.freeze({
    schemaVersion: 1,
    presets: Object.freeze([ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]),
    flightModels: Object.freeze(["fixed-wing", "flapping", "vtol"]),
    physicsKeys: VEHICLE_PHYSICS_KEYS_V1,
    physicsBounds: VEHICLE_PHYSICS_BOUNDS_V1,
    cameraBounds: VEHICLE_CAMERA_BOUNDS_V1,
    boundsLimits: VEHICLE_BOUNDS_LIMITS_V1,
    physicsRatios: VEHICLE_PHYSICS_RATIOS_V1,
    cameraDefaults: VEHICLE_CAMERA_DEFAULTS_V1,
    performanceDerivation: VEHICLE_PERFORMANCE_DERIVATION_V1,
    performanceVectors: Object.freeze([ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1].map((preset) => Object.freeze({
      id: preset.id,
      estimate: estimateVehiclePerformanceV1(preset)
    })))
  });

  // apps/creator-studio/ui/src/sdkValidation.ts
  function normalizeVehicleProfileInput(raw) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const id3 = typeof source.id === "string" ? source.id : typeof source.vehicleId === "string" ? source.vehicleId : "";
    const bounds = source.bounds && typeof source.bounds === "object" && !Array.isArray(source.bounds) ? source.bounds : {};
    const candidate = {
      schemaVersion: 1,
      id: id3,
      label: typeof source.label === "string" ? source.label : "",
      modelAssetId: source.modelAssetId === void 0 ? null : source.modelAssetId,
      flightModel: source.flightModel,
      physics: source.physics,
      bounds: source.bounds,
      camera: source.camera ?? defaultVehicleCameraV1(bounds)
    };
    const checked = validateVehicleProfileV1(candidate);
    return { ok: checked.ok, vehicle: candidate, diagnostics: checked.diagnostics };
  }

  // apps/creator-studio/ui/src/cityWorldOperations.ts
  var isObject2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var capabilityFor = (generator) => generator === "arid-dunes-v1" ? ARID_DUNES_WORLD_V2 : generator === "coastal-islands-v1" ? COASTAL_ISLANDS_WORLD_V1 : null;
  function applyCityWorldOperations(profile, operations) {
    const capability = capabilityFor(profile.geography.generator);
    if (!capability || !Array.isArray(operations) || operations.length === 0 || operations.length > 16) return null;
    const requested = {};
    for (const operation of operations) {
      if (!isObject2(operation)) return null;
      if (Object.keys(operation).some((key) => key !== "op" && key !== "preset" && key !== "params")) return null;
      if (operation.op !== "world.set") return null;
      const params = {};
      if (operation.preset !== void 0) {
        const preset = capability.presets.find((item) => item.id === operation.preset);
        if (!preset) return null;
        Object.assign(params, preset.parameters);
      }
      if (operation.params !== void 0) {
        if (!isObject2(operation.params)) return null;
        Object.assign(params, operation.params);
      }
      if (Object.keys(params).length === 0) return null;
      Object.assign(requested, params);
    }
    const checked = validateWorldParametersV1(capability, requested);
    if (!checked.ok) return null;
    const explicit = Object.fromEntries(Object.keys(requested).map((key) => [key, checked.value[key]]));
    const merged = mergeIntoProfile(profile, explicit);
    if (!merged) return null;
    const final = validateCityWorldProfile(merged);
    return final.ok ? final.value : null;
  }
  function mergeIntoProfile(profile, explicit) {
    const parameters = profile.geography.parameters;
    if (profile.geography.generator === "arid-dunes-v1") {
      const dunes = { ...parameters.dunes };
      const diversity = { ...parameters.diversity ?? {} };
      for (const [key, value] of Object.entries(explicit)) {
        if (ARID_DUNES_LEGACY_KEYS.includes(key)) dunes[key.slice("landform.".length)] = value;
        else diversity[key] = value;
      }
      const merged = { ...profile, geography: { ...profile.geography, parameters: { dunes, ...Object.keys(diversity).length > 0 ? { diversity } : {} } } };
      return merged;
    }
    if (profile.geography.generator === "coastal-islands-v1") {
      const coastal = { ...parameters.coastal };
      for (const [key, value] of Object.entries(explicit)) {
        const field = key.slice("shape.".length);
        if (!(field in coastal)) return null;
        coastal[field] = value;
      }
      const merged = { ...profile, geography: { ...profile.geography, parameters: { coastal } } };
      return merged;
    }
    return null;
  }

  // apps/creator-studio/ui/src/embeddedGate.ts
  var EMBEDDED_GATE_VERSION = 1;
  var wrap = (fn) => {
    try {
      return fn();
    } catch {
      const internal = {
        code: "embedded_gate_internal",
        severity: "error",
        path: "$",
        message: "Embedded SDK gate failed to execute this entry; treat the payload as rejected."
      };
      return { ok: false, diagnostics: [internal] };
    }
  };
  function gateValidateVehicle(raw) {
    const outcome = normalizeVehicleProfileInput(raw);
    return { ok: outcome.ok, vehicle: outcome.vehicle, diagnostics: outcome.diagnostics };
  }
  function gateEstimateVehicle(raw) {
    const outcome = normalizeVehicleProfileInput(raw);
    if (!outcome.ok) return { ok: false, vehicle: outcome.vehicle, diagnostics: outcome.diagnostics };
    return {
      ok: true,
      vehicle: outcome.vehicle,
      estimate: estimateVehiclePerformanceV1(outcome.vehicle)
    };
  }
  function gateApplyWorldEdit(city, baseRevision, operations) {
    const checked = validateCityInstance(city);
    if (!checked.ok) {
      return { ok: false, profile: {}, diagnostics: [{
        code: "creator_city_invalid",
        severity: "error",
        path: "$",
        message: "City draft failed SDK validation; the world edit is rejected."
      }] };
    }
    const fallbackProfile = checked.value.profile;
    if (checked.value.revision !== baseRevision) {
      return { ok: false, profile: fallbackProfile, diagnostics: [{
        code: "creator_validation_scope_mismatch",
        severity: "error",
        path: "baseRevision",
        message: "The preview baseRevision does not match the city draft revision."
      }] };
    }
    const merged = applyCityWorldOperations(checked.value.profile, operations);
    return { ok: merged !== null, profile: merged ?? fallbackProfile };
  }
  function gateValidateCityCreate(name, seed, profile) {
    const checked = validateCityInstance({
      schemaVersion: 1,
      cityId: "city-validation",
      revision: 0,
      name,
      seed,
      profile
    });
    return { ok: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics };
  }
  function gateValidateVehicleProfile(value) {
    const checked = validateVehicleProfileV1(value);
    return { ok: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics };
  }
  function gateValidateSceneDraft(value) {
    const checked = validateSceneDraft(value);
    return { ok: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics };
  }
  function gateValidateMiniGamePack(value) {
    const checked = validateMiniGamePack(value);
    return { ok: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics };
  }
  function gateValidateWorldParameters(capability, input) {
    const checked = validateWorldParametersV1(capability, input);
    return { ok: checked.ok, value: checked.ok ? checked.value : null, diagnostics: checked.ok ? [] : checked.diagnostics };
  }
  var rawOf = (args) => args.raw;
  var registry = {
    "vehicle.validate": (args) => gateValidateVehicle(rawOf(args)),
    "vehicle.estimate": (args) => gateEstimateVehicle(rawOf(args)),
    "vehicle.profile.validate": (args) => gateValidateVehicleProfile(rawOf(args)),
    "city.world.apply": (args) => {
      const input = args;
      return gateApplyWorldEdit(input.city, Number(input.baseRevision), input.operations);
    },
    "city.create.validate": (args) => {
      const input = args;
      return gateValidateCityCreate(input.name, input.seed, input.profile);
    },
    "scene.draft.validate": (args) => gateValidateSceneDraft(rawOf(args)),
    "game.pack.validate": (args) => gateValidateMiniGamePack(rawOf(args)),
    "world.parameters.validate": (args) => {
      const input = args;
      return gateValidateWorldParameters(input.capability, input.input);
    }
  };
  var citySdkGate = {
    version: EMBEDDED_GATE_VERSION,
    engine: "quickjs",
    invoke(entry, argsJson) {
      const handler = registry[entry];
      if (typeof handler !== "function") {
        return JSON.stringify({ ok: false, diagnostics: [{
          code: "embedded_gate_entry_unknown",
          severity: "error",
          path: "$",
          message: `Unknown embedded gate entry: ${String(entry).slice(0, 64)}`
        }] });
      }
      let parsed;
      try {
        parsed = typeof argsJson === "string" && argsJson.length > 0 ? JSON.parse(argsJson) : {};
      } catch {
        return JSON.stringify({ ok: false, diagnostics: [{
          code: "embedded_gate_args_invalid",
          severity: "error",
          path: "$",
          message: "Gate arguments are not valid JSON."
        }] });
      }
      return JSON.stringify(wrap(() => handler(parsed)));
    }
  };
  globalThis.citySdkGate = citySdkGate;
})();
