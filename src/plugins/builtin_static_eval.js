const vm = require("vm");
const t = require("@babel/types");
const generator = require("@babel/generator").default;
const { isSafeConst, makeInc } = require("../utils");

const SAFE_MATH_METHODS = new Set([
  "abs",
  "floor",
  "ceil",
  "round",
  "max",
  "min",
  "pow",
  "sqrt",
  "trunc",
  "sign",
  "log",
  "log2",
  "log10",
  "exp",
  "cbrt",
  "hypot",
  "imul",
  "fround",
  "clz32",
]);

function isSafePureCall(path) {
  // 仅对确定无副作用、且输入是常量的内置函数做静态求值
  const node = path.node;
  if (!t.isCallExpression(node)) return false;

  for (const arg of node.arguments) {
    if (t.isSpreadElement(arg)) return false;
    if (!isSafeConst(arg)) return false;
  }

  // Math.*
  if (t.isMemberExpression(node.callee) && !node.callee.computed) {
    const { object, property } = node.callee;
    if (t.isIdentifier(object, { name: "Math" }) && t.isIdentifier(property)) {
      return SAFE_MATH_METHODS.has(property.name);
    }
  }

  // String.fromCharCode
  if (
    t.isMemberExpression(node.callee) &&
    !node.callee.computed &&
    t.isIdentifier(node.callee.object, { name: "String" }) &&
    t.isIdentifier(node.callee.property, { name: "fromCharCode" })
  ) {
    return true;
  }

  // parseInt/parseFloat
  if (t.isIdentifier(node.callee) && (node.callee.name === "parseInt" || node.callee.name === "parseFloat")) {
    return true;
  }

  // atob/btoa (Node 环境中通过 Buffer polyfill)
  if (t.isIdentifier(node.callee) && (node.callee.name === "atob" || node.callee.name === "btoa")) {
    return true;
  }

  return false;
}

function buildSandbox() {
  const sandbox = {
    Math,
    String,
    parseInt,
    parseFloat,
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
  };
  return sandbox;
}

function toLiteralNode(val) {
  if (typeof val === "string") return t.stringLiteral(val);
  if (typeof val === "number") {
    if (!isFinite(val) || isNaN(val)) return null;
    return t.numericLiteral(val);
  }
  if (typeof val === "boolean") return t.booleanLiteral(val);
  if (val === null) return t.nullLiteral();
  return null;
}

module.exports = function builtinStaticEval(options = {}) {
  const sandbox = buildSandbox();
  const inc = makeInc(options.counter);

  return {
    name: "builtin-static-eval",

    visitor: {
      CallExpression: {
        exit(path) {
          if (!isSafePureCall(path)) return;

          const code = generator(path.node).code;
          try {
            const result = vm.runInNewContext(code, sandbox, { timeout: 50 });
            const lit = toLiteralNode(result);
            if (!lit) return;
            path.replaceWith(lit);
            inc();
          } catch (e) {
            // 计算失败跳过
          }
        },
      },
    },
  };
};
