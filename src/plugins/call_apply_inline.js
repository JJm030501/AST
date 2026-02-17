/**
 * call/apply 包装器内联插件
 *
 * 将常见的间接调用模式还原为直接调用:
 * 1. fn.call(null, a, b)     → fn(a, b)
 * 2. fn.call(undefined, a)   → fn(a)
 * 3. fn.apply(null, [a, b])  → fn(a, b)
 * 4. (0, obj.fn)(args)       → obj.fn(args)  (间接调用)
 */

const t = require("@babel/types");
const { makeInc } = require("../utils");

function isNullOrUndefined(node) {
  if (t.isNullLiteral(node)) return true;
  if (t.isIdentifier(node, { name: "undefined" })) return true;
  if (t.isUnaryExpression(node, { operator: "void" }) && t.isNumericLiteral(node.argument)) return true;
  return false;
}

module.exports = function callApplyInline(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "call-apply-inline",

    visitor: {
      CallExpression: {
        exit(path) {
          const { callee, arguments: args } = path.node;

          // (0, obj.fn)(args) → obj.fn(args)
          if (
            t.isSequenceExpression(callee) &&
            callee.expressions.length === 2 &&
            t.isNumericLiteral(callee.expressions[0], { value: 0 }) &&
            t.isMemberExpression(callee.expressions[1])
          ) {
            path.node.callee = callee.expressions[1];
            inc();
            return;
          }

          // fn.call(null, a, b) → fn(a, b)
          if (
            t.isMemberExpression(callee) &&
            !callee.computed &&
            t.isIdentifier(callee.property, { name: "call" })
          ) {
            if (args.length >= 1 && isNullOrUndefined(args[0])) {
              const fn = callee.object;
              const newArgs = args.slice(1);
              path.replaceWith(t.callExpression(fn, newArgs));
              inc();
              return;
            }
          }

          // fn.apply(null, [a, b]) → fn(a, b)
          if (
            t.isMemberExpression(callee) &&
            !callee.computed &&
            t.isIdentifier(callee.property, { name: "apply" })
          ) {
            if (
              args.length === 2 &&
              isNullOrUndefined(args[0]) &&
              t.isArrayExpression(args[1])
            ) {
              // 确保数组中没有 spread 元素
              const arrayArgs = args[1].elements;
              if (arrayArgs.every((el) => el !== null && !t.isSpreadElement(el))) {
                const fn = callee.object;
                path.replaceWith(t.callExpression(fn, arrayArgs));
                inc();
                return;
              }
            }
          }
        },
      },
    },
  };
};
