/**
 * 成员表达式还原插件
 *
 * 将计算属性访问还原为点号访问：
 * 1. obj["property"] → obj.property (当 property 是合法标识符时)
 * 2. obj["console"]["log"] → console.log
 */

const t = require("@babel/types");
const { makeInc } = require("../utils");

function isValidIdentifier(name) {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) && !isReservedWord(name);
}

function isReservedWord(word) {
  const reserved = new Set([
    "break", "case", "catch", "continue", "debugger", "default", "delete",
    "do", "else", "finally", "for", "function", "if", "in", "instanceof",
    "new", "return", "switch", "this", "throw", "try", "typeof", "var",
    "void", "while", "with", "class", "const", "enum", "export", "extends",
    "import", "super", "implements", "interface", "let", "package", "private",
    "protected", "public", "static", "yield",
  ]);
  return reserved.has(word);
}

module.exports = function memberExpressionSimplifier(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "member-expression-simplifier",

    visitor: {
      MemberExpression: {
        exit(path) {
          const { property, computed } = path.node;

          // obj["xxx"] → obj.xxx (仅当 xxx 是合法标识符)
          if (computed && t.isStringLiteral(property)) {
            if (isValidIdentifier(property.value)) {
              path.node.property = t.identifier(property.value);
              path.node.computed = false;
              inc();
            }
          }
        },
      },
    },
  };
};
