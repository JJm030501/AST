/**
 * 字符串数组动态解密插件
 *
 * 处理 obfuscator.io 最常见的字符串加密模式:
 *
 * 混淆代码中通常包含:
 * 1. 一个字符串数组函数:  var _0x1234 = ["log", "Hello", "console"];
 * 2. 一个数组旋转函数(shuffle): (function(_arr, _num){ while(--_num){ _arr.push(_arr.shift()); } })(_0x1234, 0x5);
 * 3. 一个解密函数: function _0x5678(_idx){ return _0x1234[_idx - 0]; }
 * 4. 实际代码中用 _0x5678(0x0) 替代 "log"
 *
 * 还原策略:
 *   提取字符串数组 + 旋转逻辑 + 解密函数，用 Node.js vm 沙箱动态执行，
 *   然后将所有 _0x5678(0x0) 调用替换为实际字符串值。
 */

const vm = require("vm");
const t = require("@babel/types");
const generator = require("@babel/generator").default;
const { parse } = require("@babel/parser");
const { isSafeLiteral, visit, removeDeclaratorAndCleanup, makeInc } = require("../utils");

function isStringArrayExpression(node) {
  if (!t.isArrayExpression(node)) return false;
  if (!node.elements.every((el) => el && t.isStringLiteral(el))) return false;
  return node.elements.length >= 5;
}

function extractStringArrayReturnExpr(fnNode, nameHint) {
  if (
    !(
      t.isFunctionDeclaration(fnNode) ||
      t.isFunctionExpression(fnNode) ||
      t.isArrowFunctionExpression(fnNode)
    )
  ) {
    return null;
  }

  if (!t.isBlockStatement(fnNode.body)) {
    return isStringArrayExpression(fnNode.body) ? fnNode.body : null;
  }

  for (const stmt of fnNode.body.body) {
    if (!t.isReturnStatement(stmt) || !stmt.argument) continue;
    if (isStringArrayExpression(stmt.argument)) return stmt.argument;
  }

  if (nameHint) {
    const body = fnNode.body.body;
    if (body.length >= 2) {
      const first = body[0];
      const last = body[body.length - 1];
      if (
        t.isVariableDeclaration(first) &&
        first.declarations.length === 1 &&
        t.isIdentifier(first.declarations[0].id) &&
        isStringArrayExpression(first.declarations[0].init) &&
        t.isReturnStatement(last) &&
        last.argument &&
        t.isCallExpression(last.argument) &&
        t.isIdentifier(last.argument.callee, { name: nameHint })
      ) {
        return first.declarations[0].init;
      }
    }
  }

  return null;
}

function isArrayGetterCall(node, getterNames) {
  return (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    getterNames.has(node.callee.name) &&
    node.arguments.length === 0
  );
}

function functionReferencesStringArrays(fnNode, arrayNames, getterNames) {
  let hit = false;
  visit(fnNode, (n) => {
    if (hit) return;
    if (t.isIdentifier(n) && arrayNames.has(n.name)) hit = true;
    if (isArrayGetterCall(n, getterNames)) hit = true;
  });
  return hit;
}

function collectCalleeNames(fnNode) {
  const out = new Set();
  visit(fnNode, (n) => {
    if (!t.isCallExpression(n)) return;
    if (!t.isIdentifier(n.callee)) return;
    out.add(n.callee.name);
  });
  return out;
}

function isLiteralArray(node) {
  if (!t.isArrayExpression(node)) return false;
  return node.elements.every((el) => {
    if (!el) return false;
    return isSafeLiteral(el) || t.isNullLiteral(el);
  });
}

function isInjectableInit(node) {
  if (!node) return false;
  if (isSafeLiteral(node)) return true;
  if (isLiteralArray(node)) return true;
  if (t.isFunctionExpression(node)) return true;
  return false;
}

function isFunctionBinding(binding) {
  if (!binding || !binding.path || binding.path.removed) return false;
  if (binding.path.isFunctionDeclaration()) return true;
  if (binding.path.isVariableDeclarator()) {
    return t.isFunctionExpression(binding.path.node.init);
  }
  return false;
}

function getFunctionPathFromBinding(binding) {
  if (!binding || !binding.path || binding.path.removed) return null;
  if (binding.path.isFunctionDeclaration()) return binding.path;
  if (binding.path.isVariableDeclarator()) {
    const initPath = binding.path.get("init");
    if (initPath && initPath.node && t.isFunctionExpression(initPath.node)) {
      return initPath;
    }
  }
  return null;
}

function collectProgramFreeBindingsFromFunction(fnPath) {
  const out = new Set();
  if (!fnPath || !fnPath.node || typeof fnPath.traverse !== "function") return out;

  fnPath.traverse({
    ReferencedIdentifier(idPath) {
      const name = idPath.node && idPath.node.name;
      if (!name) return;
      const binding = idPath.scope.getBinding(name);
      if (!binding || !binding.scope || !binding.scope.path) return;
      if (!binding.scope.path.isProgram()) return;
      out.add(name);
    },
  });

  return out;
}

function isInjectableProgramBinding(binding) {
  if (!binding || !binding.constant) return false;
  if (!binding.path || binding.path.removed) return false;
  if (!binding.scope || !binding.scope.path || !binding.scope.path.isProgram()) return false;
  if (binding.kind === "param" || binding.kind === "module") return false;

  const bpath = binding.path;
  if (
    bpath.isImportSpecifier() ||
    bpath.isImportDefaultSpecifier() ||
    bpath.isImportNamespaceSpecifier()
  ) {
    return false;
  }

  if (bpath.isFunctionDeclaration()) {
    return !!(bpath.node && bpath.node.id);
  }

  if (bpath.isVariableDeclarator()) {
    if (!t.isIdentifier(bpath.node.id)) return false;
    return isInjectableInit(bpath.node.init);
  }

  return false;
}

function toBindingCodeFragment(binding) {
  if (!binding || !binding.path || binding.path.removed) return null;
  const bpath = binding.path;

  if (bpath.isFunctionDeclaration()) {
    return generator(bpath.node).code;
  }

  if (bpath.isVariableDeclarator()) {
    const id = bpath.node.id;
    const init = bpath.node.init;
    if (!t.isIdentifier(id) || !init) return null;
    return `var ${id.name} = ${generator(init).code};`;
  }

  return null;
}

function collectInjectableDependencyCodeFragments(programPath, includeFuncNames, maxDepth = 3) {
  const orderedNames = [];
  const emitted = new Set();
  const visiting = new Set();
  const skipNames = new Set(includeFuncNames || []);

  function visitDependencyName(name, depth) {
    if (!name) return;
    if (depth > maxDepth) return;
    if (skipNames.has(name)) return;
    if (emitted.has(name) || visiting.has(name)) return;

    const binding = programPath.scope.getBinding(name);
    if (!isInjectableProgramBinding(binding)) return;

    visiting.add(name);

    const fnPath = getFunctionPathFromBinding(binding);
    if (fnPath) {
      const deps = collectProgramFreeBindingsFromFunction(fnPath);
      for (const dep of deps) {
        visitDependencyName(dep, depth + 1);
      }
    }

    visiting.delete(name);
    emitted.add(name);
    orderedNames.push(name);
  }

  for (const funcName of Array.from(includeFuncNames || [])) {
    const binding = programPath.scope.getBinding(funcName);
    const fnPath = getFunctionPathFromBinding(binding);
    if (!fnPath) continue;
    const deps = collectProgramFreeBindingsFromFunction(fnPath);
    for (const dep of deps) {
      visitDependencyName(dep, 1);
    }
  }

  const fragments = [];
  for (const name of orderedNames) {
    const binding = programPath.scope.getBinding(name);
    const fragment = toBindingCodeFragment(binding);
    if (fragment) fragments.push(fragment);
  }
  return fragments;
}

function stringToNumberSafe(s) {
  if (typeof s !== "string") return null;
  const str = s.trim();
  if (!str) return null;
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(str) || /^[+-]?0x[0-9a-f]+$/i.test(str)) {
    const n = Number(str);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getConstArgValue(node, scope, depth = 0) {
  if (!node) return null;
  if (depth > 8) return null;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) return node.value;

  if (t.isIdentifier(node) && scope && typeof scope.getBinding === "function") {
    const binding = scope.getBinding(node.name);
    if (!binding || !binding.constant) return null;
    if (!binding.path || binding.path.removed) return null;
    if (!binding.path.isVariableDeclarator()) return null;
    const init = binding.path.node.init;
    if (!init) return null;
    return getConstArgValue(init, binding.path.scope || scope, depth + 1);
  }

  if (t.isUnaryExpression(node)) {
    const v = getConstArgValue(node.argument, scope, depth + 1);
    if (v === null) return null;
    if (node.operator === "+") {
      if (typeof v === "number") return v;
      const n = stringToNumberSafe(v);
      return n === null ? null : n;
    }
    if (node.operator === "-") {
      if (typeof v !== "number") return null;
      return -v;
    }
    if (node.operator === "~") {
      if (typeof v !== "number") return null;
      return ~v;
    }
  }

  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
    const name = node.callee.name;
    if (name === "parseInt") {
      if (!node.arguments || node.arguments.length < 1 || node.arguments.length > 2) return null;
      const a0 = getConstArgValue(node.arguments[0], scope, depth + 1);
      if (a0 === null) return null;
      const s = typeof a0 === "string" ? a0 : String(a0);
      let radix;
      if (node.arguments.length >= 2) {
        const a1 = getConstArgValue(node.arguments[1], scope, depth + 1);
        if (typeof a1 !== "number") return null;
        radix = a1;
      }
      const n = radix == null ? parseInt(s) : parseInt(s, radix);
      return Number.isFinite(n) ? n : null;
    }
    if (name === "Number") {
      if (!node.arguments || node.arguments.length !== 1) return null;
      const a0 = getConstArgValue(node.arguments[0], scope, depth + 1);
      if (a0 === null) return null;
      const n = typeof a0 === "number" ? a0 : stringToNumberSafe(a0);
      return n === null ? null : n;
    }
  }

  if (t.isBinaryExpression(node)) {
    const l = getConstArgValue(node.left, scope, depth + 1);
    const r = getConstArgValue(node.right, scope, depth + 1);
    if (typeof l === "number" && typeof r === "number") {
      switch (node.operator) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return r === 0 ? null : l / r;
        case "%":
          return r === 0 ? null : l % r;
        case "<<":
          return l << r;
        case ">>":
          return l >> r;
        case ">>>":
          return l >>> r;
        case "|":
          return l | r;
        case "&":
          return l & r;
        case "^":
          return l ^ r;
        default:
          return null;
      }
    }
    if (typeof l === "string" && typeof r === "string" && node.operator === "+") {
      return l + r;
    }
  }
  return null;
}

function toJsArgLiteral(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  return null;
}

function removeBindingIfUnreferenced(programPath, name) {
  const binding = programPath.scope.getBinding(name);
  if (!binding) return false;

  const bindingContainer = binding.path && binding.path.isIdentifier()
    ? binding.path.parentPath
    : binding.path;

  const hasExternalRefs = (binding.referencePaths || []).some((rp) => {
    if (!rp || rp.removed) return false;
    if (!bindingContainer) return true;
    return !rp.findParent((p) => p === bindingContainer);
  });

  if (hasExternalRefs) return false;

  const bpath = binding.path;
  if (!bpath || bpath.removed) return false;
  if (bpath.isVariableDeclarator()) {
    removeDeclaratorAndCleanup(bpath);
    return true;
  }
  if (bpath.isFunctionDeclaration()) {
    try { bpath.remove(); } catch (e) {}
    return true;
  }

  return false;
}

module.exports = function stringArrayDecoder(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "string-array-decoder",

    visitor: {
      Program: {
        enter(programPath) {
          // Step 1: 识别字符串数组声明
          //   模式: var _0xNNNN = ["str1", "str2", ...];
          const stringArrays = {};
          const arrayGetterNames = new Set();
          const arrayAliasNames = new Set();
          const toRemove = [];

          // 识别 function getter(){ return ["a", ...]; } 或 cached getter 变体
          programPath.traverse({
            FunctionDeclaration(path) {
              const fnName = path.node.id && path.node.id.name;
              if (!fnName) return;
              const arrExpr = extractStringArrayReturnExpr(path.node, fnName);
              if (!arrExpr) return;
              arrayGetterNames.add(fnName);
              toRemove.push(path);
            },
          });

          programPath.traverse({
            VariableDeclarator(path) {
              const { id, init } = path.node;
              if (!t.isIdentifier(id)) return;

              // 直接数组: var _arr = ["a", ...]
              if (isStringArrayExpression(init)) {
                stringArrays[id.name] = init.elements.map((el) => el.value);
                toRemove.push(path);
                return;
              }

              // getter: var _get = function(){ return ["a", ...] }
              if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
                const arrExpr = extractStringArrayReturnExpr(init, id.name);
                if (!arrExpr) return;
                arrayGetterNames.add(id.name);
                toRemove.push(path);
                return;
              }

              // alias: var _a = _get();
              if (
                t.isCallExpression(init) &&
                t.isIdentifier(init.callee) &&
                init.arguments.length === 0 &&
                arrayGetterNames.has(init.callee.name)
              ) {
                arrayAliasNames.add(id.name);
                toRemove.push(path);
              }
            },
          });

          if (Object.keys(stringArrays).length === 0 && arrayGetterNames.size === 0) return;

          // Step 2: 识别数组旋转函数 (IIFE)
          //   模式: (function(arr, num){ while(--num){ arr.push(arr.shift()); } })(arrayName, 0xNN)
          const rotationIIFEs = [];

          programPath.traverse({
            ExpressionStatement(path) {
              const expr = path.node.expression;
              if (!t.isCallExpression(expr)) return;
              if (!t.isFunctionExpression(expr.callee)) return;
              if (expr.arguments.length < 2) return;

              const firstArg = expr.arguments[0];
              if (
                t.isIdentifier(firstArg) &&
                (stringArrays[firstArg.name] || arrayAliasNames.has(firstArg.name))
              ) {
                rotationIIFEs.push({
                  path,
                  arrayName: firstArg.name,
                });
                return;
              }

              if (isArrayGetterCall(firstArg, arrayGetterNames)) {
                rotationIIFEs.push({
                  path,
                  arrayName: firstArg.callee.name,
                  isGetterCall: true,
                });
              }
            },
          });

          // Step 3: 识别解密函数
          //   模式: function _0xNNNN(idx, ...){ return arrayName[idx - offset]; }
          //   或:   var _0xNNNN = function(idx, ...){ ... arrayName ... }
          const decoderFuncs = {};
          const obfFuncDefs = {};

          const arrayNames = new Set([
            ...Object.keys(stringArrays),
            ...Array.from(arrayAliasNames),
          ]);

          programPath.traverse({
            FunctionDeclaration(path) {
              const funcName = path.node.id?.name;
              if (!funcName || !/^_0x/i.test(funcName)) return;

              obfFuncDefs[funcName] = { path };
              if (!functionReferencesStringArrays(path.node, arrayNames, arrayGetterNames)) return;
              decoderFuncs[funcName] = { path };
            },
            VariableDeclarator(path) {
              const { id, init } = path.node;
              if (!t.isIdentifier(id)) return;
              if (!/^_0x/i.test(id.name)) return;

              if (!(t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) return;

              obfFuncDefs[id.name] = { path, isVar: true };

              if (!functionReferencesStringArrays(init, arrayNames, arrayGetterNames)) return;
              decoderFuncs[id.name] = { path, isVar: true };
            },
          });

          if (Object.keys(decoderFuncs).length === 0) return;

          // 收集被常量参数调用的 _0x* 函数名，避免把整个 bundle 的函数塞进沙箱
          const calledObfNames = new Set();
          programPath.traverse({
            CallExpression(p) {
              const { callee, arguments: args } = p.node;
              if (!t.isIdentifier(callee)) return;
              if (!/^_0x/i.test(callee.name)) return;
              for (const a of args) {
                if (getConstArgValue(a, p.scope) === null) return;
              }
              calledObfNames.add(callee.name);
            },
          });

          // 构建需要注入沙箱的函数集合：decoder + 被调用的 wrapper + 依赖闭包
          const includeFuncNames = new Set();
          for (const n of Object.keys(decoderFuncs)) includeFuncNames.add(n);
          for (const n of calledObfNames) {
            if (obfFuncDefs[n]) includeFuncNames.add(n);
          }

          let changed = true;
          while (changed) {
            changed = false;
            for (const name of Array.from(includeFuncNames)) {
              const def = obfFuncDefs[name];
              if (!def || !def.path || def.path.removed) continue;
              const node = def.path.isFunctionDeclaration()
                ? def.path.node
                : def.path.isVariableDeclarator()
                  ? def.path.node.init
                  : null;
              if (!node) continue;
              for (const calleeName of Array.from(collectCalleeNames(node))) {
                if (!/^_0x/i.test(calleeName)) continue;
                if (!obfFuncDefs[calleeName]) continue;
                if (!includeFuncNames.has(calleeName)) {
                  includeFuncNames.add(calleeName);
                  changed = true;
                }
              }
            }
          }

          const dependencyFragments = collectInjectableDependencyCodeFragments(
            programPath,
            includeFuncNames,
            3
          );

          // Step 4: 用 vm 沙箱执行字符串数组 + 旋转 + 解密函数
          // 收集需要执行的代码片段(按顺序)
          const codeFragments = [];

          // 字符串数组声明
          for (const [name, arr] of Object.entries(stringArrays)) {
            codeFragments.push(`var ${name} = ${JSON.stringify(arr)};`);
          }

          // 数组 getter / cached getter
          if (arrayGetterNames.size > 0) {
            programPath.traverse({
              FunctionDeclaration(path) {
                const fnName = path.node.id && path.node.id.name;
                if (!fnName) return;
                if (!arrayGetterNames.has(fnName)) return;
                codeFragments.push(generator(path.node).code);
              },
              VariableDeclarator(path) {
                const { id, init } = path.node;
                if (!t.isIdentifier(id)) return;
                if (!arrayGetterNames.has(id.name)) return;
                if (!(t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) return;
                codeFragments.push(`var ${id.name} = ${generator(init).code};`);
              },
            });
          }

          // getter() 别名
          if (arrayAliasNames.size > 0) {
            programPath.traverse({
              VariableDeclarator(path) {
                const { id, init } = path.node;
                if (!t.isIdentifier(id)) return;
                if (!arrayAliasNames.has(id.name)) return;
                if (!(t.isCallExpression(init) && t.isIdentifier(init.callee) && init.arguments.length === 0)) return;
                codeFragments.push(`var ${id.name} = ${init.callee.name}();`);
              },
            });
          }

          // 旋转 IIFE
          for (const { path: iifePath } of rotationIIFEs) {
            codeFragments.push(generator(iifePath.node).code);
          }

          // include 函数的 program-scope 常量依赖 (仅受限类型, 递归深度 <= 3)
          for (const fragment of dependencyFragments) {
            codeFragments.push(fragment);
          }

          // 解密函数
          for (const [funcName, { path: funcPath }] of Object.entries(decoderFuncs)) {
            if (funcPath.isFunctionDeclaration()) {
              codeFragments.push(generator(funcPath.node).code);
            } else if (funcPath.isVariableDeclarator()) {
              const id = funcPath.node.id;
              const init = funcPath.node.init;
              if (t.isIdentifier(id) && (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) {
                codeFragments.push(`var ${id.name} = ${generator(init).code};`);
              }
            }
          }

          // wrapper/别名函数：把需要的 _0x* 函数也加进沙箱（仅定义，不执行）
          for (const [funcName, { path: funcPath }] of Object.entries(obfFuncDefs)) {
            if (decoderFuncs[funcName]) continue;
            if (!includeFuncNames.has(funcName)) continue;

            if (funcPath.isFunctionDeclaration()) {
              codeFragments.push(generator(funcPath.node).code);
            } else if (funcPath.isVariableDeclarator()) {
              const id = funcPath.node.id;
              const init = funcPath.node.init;
              if (t.isIdentifier(id) && (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) {
                codeFragments.push(`var ${id.name} = ${generator(init).code};`);
              }
            }
          }

          // 创建沙箱执行
          const sandbox = { Math, parseInt, parseFloat, String };
          const setupCode = codeFragments.join("\n");

          try {
            vm.runInNewContext(setupCode, sandbox, { timeout: 300 });
          } catch (e) {
            // 如果沙箱执行失败, 跳过动态解密
            return;
          }

          // 把解密函数暴露到沙箱中
          for (const funcName of Object.keys(decoderFuncs)) {
            if (typeof sandbox[funcName] !== "function") {
              // 尝试 eval 获取
              try {
                sandbox[funcName] = vm.runInNewContext(
                  setupCode + `\n;${funcName};`,
                  sandbox,
                  { timeout: 300 }
                );
              } catch (e) {
                continue;
              }
            }
          }

          // Step 5: 替换所有解密函数调用为实际字符串
          let replaceCount = 0;
          const replacedNames = new Set();
          const constArgNames = new Set();

          programPath.traverse({
            CallExpression(path) {
              const { callee, arguments: args } = path.node;
              if (!t.isIdentifier(callee)) return;
              if (!/^_0x/i.test(callee.name)) return;
              if (!includeFuncNames.has(callee.name) && !decoderFuncs[callee.name]) return;

              const fnExists = typeof sandbox[callee.name] === "function";
              if (!fnExists) return;

              // 收集参数值
              const argValues = [];
              for (const arg of args) {
                if (t.isIdentifier(arg)) constArgNames.add(arg.name);
                const v = getConstArgValue(arg, path.scope);
                if (v === null) return;
                argValues.push(v);
              }

              const argLits = argValues.map(toJsArgLiteral);
              if (argLits.some((x) => x === null)) return;

              try {
                const result = vm.runInNewContext(
                  `${callee.name}(${argLits.join(",")})`,
                  sandbox,
                  { timeout: 50 }
                );
                if (typeof result === "string") {
                  path.replaceWith(t.stringLiteral(result));
                  replaceCount++;
                  inc();
                  replacedNames.add(callee.name);
                }
              } catch (e) {
                // 解密失败, 跳过
              }
            },
          });

          // Step 6: 清理字符串数组、旋转 IIFE、解密函数的声明
          if (replaceCount > 0) {
            try {
              programPath.scope.crawl();
            } catch (e) {}
            for (const name of Array.from(replacedNames)) {
              if (removeBindingIfUnreferenced(programPath, name)) inc();
            }

            try {
              programPath.scope.crawl();
            } catch (e) {}
            for (const name of Array.from(constArgNames)) {
              if (removeBindingIfUnreferenced(programPath, name)) inc();
            }

            try {
              programPath.scope.crawl();
            } catch (e) {}
            for (const name of Object.keys(decoderFuncs)) {
              if (removeBindingIfUnreferenced(programPath, name)) inc();
            }

            try {
              programPath.scope.crawl();
            } catch (e) {}

            for (const { path: iifePath, arrayName, isGetterCall } of rotationIIFEs) {
              const binding = programPath.scope.getBinding(arrayName);
              if (binding && binding.referencePaths && binding.referencePaths.length > 0) {
                const bindingContainer = binding.path && binding.path.isIdentifier()
                  ? binding.path.parentPath
                  : binding.path;
                const hasRefOutsideIife = binding.referencePaths.some((rp) => {
                  if (!rp || rp.removed) return false;
                  if (bindingContainer && rp.findParent((p) => p === bindingContainer)) return false;
                  return !rp.findParent((p) => p === iifePath);
                });
                if (hasRefOutsideIife) continue;
              }
              try {
                iifePath.remove();
                inc();
              } catch (e) {}
            }

            try {
              programPath.scope.crawl();
            } catch (e) {}

            for (const name of Object.keys(stringArrays)) {
              if (removeBindingIfUnreferenced(programPath, name)) inc();
            }
            for (const name of Array.from(arrayAliasNames)) {
              if (removeBindingIfUnreferenced(programPath, name)) inc();
            }
            for (const name of Array.from(arrayGetterNames)) {
              if (removeBindingIfUnreferenced(programPath, name)) inc();
            }
          }
        },
      },
    },
  };
};
