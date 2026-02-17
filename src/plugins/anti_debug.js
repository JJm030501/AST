const t = require("@babel/types");
const { makeInc } = require("../utils");

function isOnlyDebugger(fnNode) {
  if (!(t.isFunctionExpression(fnNode) || t.isArrowFunctionExpression(fnNode))) return false;

  if (t.isBlockStatement(fnNode.body)) {
    const body = fnNode.body.body;
    if (body.length !== 1) return false;
    return t.isDebuggerStatement(body[0]);
  }

  return t.isDebuggerStatement(fnNode.body);
}

function containsDebuggerString(node) {
  if (!t.isStringLiteral(node)) return false;
  return /\bdebugger\b/.test(node.value);
}

module.exports = function antiDebug(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "anti-debug",

    visitor: {
      DebuggerStatement(path) {
        path.remove();
        inc();
      },

      CallExpression(path) {
        const { callee, arguments: args } = path.node;

        // setInterval(function(){debugger}, 1000) / setTimeout(...)
        if (t.isIdentifier(callee) && (callee.name === "setInterval" || callee.name === "setTimeout")) {
          const fnArg = args[0];
          if (fnArg && isOnlyDebugger(fnArg)) {
            if (path.parentPath.isExpressionStatement()) {
              path.parentPath.remove();
              inc();
            } else {
              path.replaceWith(t.numericLiteral(0));
              inc();
            }
          }
          return;
        }

        // Function("debugger")()
        if (t.isCallExpression(callee) && t.isIdentifier(callee.callee, { name: "Function" })) {
          const first = callee.arguments[0];
          if (first && containsDebuggerString(first)) {
            if (path.parentPath.isExpressionStatement()) {
              path.parentPath.remove();
              inc();
            } else {
              path.replaceWith(t.numericLiteral(0));
              inc();
            }
          }
          return;
        }

        // Function("...") with debugger string (non-invoked)
        if (t.isIdentifier(callee, { name: "Function" })) {
          const first = args[0];
          if (first && containsDebuggerString(first)) {
            if (path.parentPath.isExpressionStatement()) {
              path.parentPath.remove();
              inc();
            } else {
              path.replaceWith(t.numericLiteral(0));
              inc();
            }
          }
        }
      },
    },
  };
};
