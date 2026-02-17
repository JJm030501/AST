const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const t = require("@babel/types");
const { visit } = require("./utils");

function parseCode(code) {
  return parser.parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [
      "dynamicImport",
      "importMeta",
      "numericSeparator",
      "bigInt",
      "logicalAssignment",
      "optionalChaining",
      "nullishCoalescingOperator",
      "objectRestSpread",
      "classProperties",
      "classPrivateProperties",
      "classPrivateMethods",
      "privateIn",
      "topLevelAwait",
    ],
  });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function sanitizeFileName(name) {
  const s = String(name == null ? "" : name);
  const cleaned = s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 200);
  return cleaned || "module";
}

function containsIdentifier(node, names) {
  let hit = false;
  visit(node, (n) => {
    if (hit) return;
    if (t.isIdentifier(n) && names.has(n.name)) hit = true;
  });
  return hit;
}

function containsWebpackChunkName(node) {
  let hit = false;
  visit(node, (n) => {
    if (hit) return;
    if (t.isIdentifier(n) && n.name === "webpackJsonp") {
      hit = true;
      return;
    }
    if (t.isStringLiteral(n)) {
      const v = n.value;
      if (typeof v === "string" && (v.includes("webpackJsonp") || v.startsWith("webpackChunk"))) {
        hit = true;
      }
    }
  });
  return hit;
}

function isModuleFactory(fn) {
  if (!(t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn))) return false;
  if (!t.isBlockStatement(fn.body)) return false;
  if (!fn.params || fn.params.length < 1) return false;
  if (fn.params.length > 5) return false;
  return true;
}

function extractFromContainer(node) {
  const out = [];

  if (t.isArrayExpression(node)) {
    for (let i = 0; i < node.elements.length; i++) {
      const el = node.elements[i];
      if (!el) continue;
      if (!isModuleFactory(el)) continue;
      out.push({ id: String(i), fn: el });
    }
    return out;
  }

  if (t.isObjectExpression(node)) {
    for (const prop of node.properties) {
      if (!t.isObjectProperty(prop)) continue;
      if (prop.computed) continue;
      const v = prop.value;
      if (!isModuleFactory(v)) continue;

      let key;
      if (t.isNumericLiteral(prop.key)) key = String(prop.key.value);
      else if (t.isStringLiteral(prop.key)) key = prop.key.value;
      else if (t.isIdentifier(prop.key)) key = prop.key.name;
      else continue;

      out.push({ id: String(key), fn: v });
    }
    return out;
  }

  return out;
}

function resolveContainerNode(node, scope, depth = 0) {
  if (!node) return null;
  if (depth > 6) return null;

  if (t.isParenthesizedExpression && t.isParenthesizedExpression(node)) {
    return resolveContainerNode(node.expression, scope, depth + 1);
  }

  if (t.isSequenceExpression(node)) {
    const last = node.expressions && node.expressions[node.expressions.length - 1];
    return resolveContainerNode(last, scope, depth + 1);
  }

  if (t.isAssignmentExpression(node)) {
    return resolveContainerNode(node.right, scope, depth + 1);
  }

  if (t.isObjectExpression(node) || t.isArrayExpression(node)) return node;

  if (t.isIdentifier(node) && scope && typeof scope.getBinding === "function") {
    const binding = scope.getBinding(node.name);
    if (!binding || !binding.path || binding.path.removed) return null;
    if (binding.path.isVariableDeclarator()) {
      const init = binding.path.node.init;
      if (!init) return null;
      return resolveContainerNode(init, binding.path.scope || scope, depth + 1);
    }
  }

  return null;
}

function findModulesContainerInPushPayload(payload, scope) {
  const resolvedPayload = resolveContainerNode(payload, scope);
  if (!resolvedPayload || !t.isArrayExpression(resolvedPayload)) return null;

  // webpack5: .push([[chunkId], modules, runtime?])
  // webpack4: .push([[chunkId], modules, runtime]) 或 .push([chunkIds, modules, runtime])
  if (resolvedPayload.elements && resolvedPayload.elements.length >= 2) {
    const second = resolvedPayload.elements[1];
    const resolvedSecond = resolveContainerNode(second, scope);
    if (resolvedSecond) {
      const ms = extractFromContainer(resolvedSecond);
      if (ms.length >= 1) return resolvedSecond;
    }
  }

  // 保守兜底：在 payload 中找到第一个看起来像模块容器的元素
  for (const el of resolvedPayload.elements || []) {
    if (!el) continue;
    const resolvedEl = resolveContainerNode(el, scope);
    if (!resolvedEl) continue;
    const ms = extractFromContainer(resolvedEl);
    if (ms.length >= 1) return resolvedEl;
  }

  return null;
}

function extractChunkKeysFromAst(ast) {
  const keys = new Set();
  traverse(ast, {
    MemberExpression(p) {
      const n = p.node;
      if (!n.computed) return;
      if (!t.isStringLiteral(n.property)) return;
      const v = n.property.value;
      if (typeof v !== "string") return;
      if (v.startsWith("webpackChunk") || v.includes("webpackJsonp")) keys.add(v);
    },
    Identifier(p) {
      if (p.node.name === "webpackJsonp") keys.add("webpackJsonp");
    },
  });
  return Array.from(keys);
}

function findWebpackModuleContainers(ast) {
  let hasWebpackRequire = false;
  const containers = [];

  traverse(ast, {
    Identifier(p) {
      if (p.node.name === "__webpack_require__") hasWebpackRequire = true;
    },
  });

  // 1) webpack runtime 内部的 __webpack_modules__
  if (hasWebpackRequire) {
    traverse(ast, {
      VariableDeclarator(p) {
        const { id, init } = p.node;
        if (!init) return;
        if (t.isIdentifier(id, { name: "__webpack_modules__" })) {
          const modules = extractFromContainer(init);
          if (modules.length >= 2) containers.push(init);
        }
      },
    });
  }

  // 2) IIFE bootstrap: (function(mods){ ... __webpack_require__ ... })(mods)
  if (hasWebpackRequire) {
    traverse(ast, {
      CallExpression(p) {
        const { callee, arguments: args } = p.node;
        if (!(t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee))) return;
        if (!args || args.length < 1) return;
        const candidate = resolveContainerNode(args[0], p.scope);
        if (!candidate) return;
        const modules = extractFromContainer(candidate);
        if (modules.length < 2) return;
        if (!containsIdentifier(callee, new Set(["__webpack_require__"]))) return;
        containers.push(candidate);
      },
    });
  }

  // 3) webpack4/5 chunk push: (self["webpackChunk..."]=self[... ]||[]).push([..., modules, ...])
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isMemberExpression(callee)) return;

      const prop = callee.property;
      const isPush =
        (!callee.computed && t.isIdentifier(prop, { name: "push" })) ||
        (callee.computed && t.isStringLiteral(prop, { value: "push" }));
      if (!isPush) return;

      if (!args || args.length < 1) return;
      const payload = args[0];
      const modulesNode = findModulesContainerInPushPayload(payload, p.scope);
      if (!modulesNode) return;

      const looksLikeChunk = containsWebpackChunkName(callee.object);
      if (!looksLikeChunk) return;

      containers.push(modulesNode);
    },
  });

  // 去重（同一个节点可能被多次加入）
  const uniq = [];
  const seen = new Set();
  for (const c of containers) {
    const key = c && c.start != null && c.end != null ? `${c.start}:${c.end}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    uniq.push(c);
  }
  return uniq;
}

function extractWebpackModulesFromAst(ast) {
  const containers = findWebpackModuleContainers(ast);
  if (!containers.length) return null;

  const chunkKeys = extractChunkKeysFromAst(ast);

  const merged = new Map();
  for (const c of containers) {
    const ms = extractFromContainer(c);
    for (const m of ms) {
      if (!merged.has(m.id)) merged.set(m.id, m);
    }
  }

  const modules = Array.from(merged.values());
  if (!modules.length) return null;

  return {
    moduleCount: modules.length,
    modules,
    chunkKeys,
  };
}

function extractWebpackModulesFromCode(code) {
  let ast;
  try {
    ast = parseCode(code);
  } catch (e) {
    return null;
  }
  return extractWebpackModulesFromAst(ast);
}

function writeWebpackModules(extracted, outDir) {
  if (!extracted || !extracted.modules || !Array.isArray(extracted.modules)) return 0;
  ensureDir(outDir);

  const mappingPath = path.join(outDir, "modules.json");
  let mapping = {};
  if (fs.existsSync(mappingPath)) {
    try {
      const raw = fs.readFileSync(mappingPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) mapping = parsed;
    } catch (e) {}
  }

  const used = new Set(Object.values(mapping || {}));
  let count = 0;

  for (const m of extracted.modules) {
    const mid = String(m.id);
    if (mapping[mid]) continue;

    const base = sanitizeFileName(m.id);
    let file = `${base}.js`;
    let n = 1;
    while (used.has(file)) {
      file = `${base}_${n}.js`;
      n++;
    }
    used.add(file);
    mapping[mid] = file;

    const abs = path.join(outDir, file);
    const code = generator(m.fn, { comments: true, jsescOption: { minimal: true } }).code;
    fs.writeFileSync(abs, code, "utf-8");
    count++;
  }

  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), "utf-8");
  return count;
}

module.exports = {
  extractWebpackModulesFromCode,
  extractWebpackModulesFromAst,
  writeWebpackModules,
};
