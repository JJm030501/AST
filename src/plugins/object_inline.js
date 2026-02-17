const t = require("@babel/types");
const { isSafeLiteral, collectIdentifiers, substitute, extractReturnExpr, makeInc } = require("../utils");

function getPropKeyName(prop) {
  if (!t.isObjectProperty(prop)) return null;
  const { key, computed } = prop;
  if (computed) return null;
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  return null;
}

function tryInlineWrapper(fnNode, callArgs) {
  const params = fnNode.params;
  if (!params.every((p) => t.isIdentifier(p))) return null;

  const returnExpr = extractReturnExpr(fnNode);
  if (!returnExpr) return null;

  const paramNames = params.map((p) => p.name);
  const paramSet = new Set(paramNames);

  const ids = new Set();
  collectIdentifiers(returnExpr, ids);
  for (const name of ids) {
    if (paramSet.has(name)) continue;
    if (name === "undefined" || name === "NaN" || name === "Infinity" || name === "Math") continue;
    return null;
  }

  const paramMap = new Map();
  for (let i = 0; i < params.length; i++) {
    const arg = callArgs[i];
    if (!arg) return null;
    paramMap.set(params[i].name, arg);
  }

  return substitute(returnExpr, paramMap);
}

module.exports = function objectInline(options = {}) {
  const objectMaps = new Map();
  const inc = makeInc(options.counter);

  return {
    name: "object-inline",

    visitor: {
      Program: {
        enter(programPath) {
          programPath.traverse({
            VariableDeclarator(path) {
              const { id, init } = path.node;
              if (!t.isIdentifier(id)) return;
              if (!t.isObjectExpression(init)) return;

              const binding = path.scope.getBinding(id.name);
              if (!binding || !binding.constant) return;

              const propMap = new Map();
              for (const prop of init.properties) {
                if (!t.isObjectProperty(prop)) return;
                const keyName = getPropKeyName(prop);
                if (!keyName) return;

                const val = prop.value;
                if (
                  !isSafeLiteral(val) &&
                  !t.isFunctionExpression(val) &&
                  !t.isArrowFunctionExpression(val)
                ) {
                  return;
                }

                propMap.set(keyName, val);
              }

              if (propMap.size > 0) {
                objectMaps.set(id.name, propMap);
              }
            },
          });
        },
      },

      // obj["str"] → "str" (仅在读上下文)
      MemberExpression(path) {
        if (!path.isReferenced()) return;
        if (path.parentPath.isCallExpression({ callee: path.node })) return;

        const { object, property, computed } = path.node;
        if (!t.isIdentifier(object)) return;
        const propMap = objectMaps.get(object.name);
        if (!propMap) return;

        let key;
        if (computed && t.isStringLiteral(property)) key = property.value;
        else if (!computed && t.isIdentifier(property)) key = property.name;
        else return;

        const val = propMap.get(key);
        if (!val) return;
        if (!isSafeLiteral(val)) return;

        path.replaceWith(t.cloneNode(val, true));
        inc();
      },

      // obj["fn"](a,b) → a+b / a===b / ... (包装器内联)
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isMemberExpression(callee)) return;

        const { object, property, computed } = callee;
        if (!t.isIdentifier(object)) return;
        const propMap = objectMaps.get(object.name);
        if (!propMap) return;

        let key;
        if (computed && t.isStringLiteral(property)) key = property.value;
        else if (!computed && t.isIdentifier(property)) key = property.name;
        else return;

        const val = propMap.get(key);
        if (!val) return;

        // 字典字符串: console[obj["log"]](...) 常见
        if (isSafeLiteral(val)) {
          if (
            callee.computed &&
            t.isStringLiteral(callee.property) &&
            t.isStringLiteral(val) &&
            callee.property.value === val.value
          ) {
            return;
          }
          path.node.callee = t.memberExpression(
            t.cloneNode(object, true),
            t.cloneNode(val, true),
            true
          );
          inc();
          return;
        }

        if (!(t.isFunctionExpression(val) || t.isArrowFunctionExpression(val))) return;

        const inlined = tryInlineWrapper(val, path.node.arguments);
        if (!inlined) return;

        path.replaceWith(inlined);
        inc();
      },
    },
  };
};
