/**
 * 常量折叠插件
 *
 * 将可在编译期计算的表达式直接替换为结果值：
 * 1. 数值运算: 1 + 2 → 3
 * 2. 字符串拼接: "he" + "llo" → "hello"
 * 3. 比较表达式: 1 === 1 → true
 * 4. 逻辑表达式: true && false → false
 * 5. 一元表达式: !0 → true, !1 → false, void 0 → undefined
 * 6. 条件表达式: true ? "a" : "b" → "a"
 */

const t = require("@babel/types");
const { makeInc } = require("../utils");

module.exports = function constantFolding(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "constant-folding",

    visitor: {
      // 二元运算常量折叠: 1 + 2 → 3, "a" + "b" → "ab"
      BinaryExpression: {
        exit(path) {
          const { left, right, operator } = path.node;

          // 两边都是字面量才处理
          if (!t.isLiteral(left) || !t.isLiteral(right)) return;
          // 排除 RegExp
          if (t.isRegExpLiteral(left) || t.isRegExpLiteral(right)) return;
          // 排除 TemplateLiteral
          if (t.isTemplateLiteral(left) || t.isTemplateLiteral(right)) return;

          const lv = left.value;
          const rv = right.value;
          let result;

          switch (operator) {
            case "+": result = lv + rv; break;
            case "-": result = lv - rv; break;
            case "*": result = lv * rv; break;
            case "/": result = rv !== 0 ? lv / rv : undefined; break;
            case "%": result = rv !== 0 ? lv % rv : undefined; break;
            case "**": result = lv ** rv; break;
            case "|": result = lv | rv; break;
            case "&": result = lv & rv; break;
            case "^": result = lv ^ rv; break;
            case "<<": result = lv << rv; break;
            case ">>": result = lv >> rv; break;
            case ">>>": result = lv >>> rv; break;
            case "==": result = lv == rv; break;
            case "!=": result = lv != rv; break;
            case "===": result = lv === rv; break;
            case "!==": result = lv !== rv; break;
            case "<": result = lv < rv; break;
            case ">": result = lv > rv; break;
            case "<=": result = lv <= rv; break;
            case ">=": result = lv >= rv; break;
            default: return;
          }

          if (result === undefined) return;

          if (typeof result === "number") {
            if (!isFinite(result) || isNaN(result)) return;
            path.replaceWith(t.numericLiteral(result));
            inc();
          } else if (typeof result === "string") {
            path.replaceWith(t.stringLiteral(result));
            inc();
          } else if (typeof result === "boolean") {
            path.replaceWith(t.booleanLiteral(result));
            inc();
          }
        },
      },

      // 一元表达式: !0 → true, !1 → false, !"" → true, void 0 → undefined
      UnaryExpression: {
        exit(path) {
          const { operator, argument } = path.node;

          if (operator === "!" && t.isNumericLiteral(argument)) {
            path.replaceWith(t.booleanLiteral(!argument.value));
            inc();
            return;
          }

          if (operator === "!" && t.isBooleanLiteral(argument)) {
            path.replaceWith(t.booleanLiteral(!argument.value));
            inc();
            return;
          }

          if (operator === "!" && t.isStringLiteral(argument)) {
            path.replaceWith(t.booleanLiteral(!argument.value));
            inc();
            return;
          }

          if (operator === "void" && t.isNumericLiteral(argument, { value: 0 })) {
            path.replaceWith(t.identifier("undefined"));
            inc();
            return;
          }

          if (operator === "typeof" && t.isStringLiteral(argument)) {
            path.replaceWith(t.stringLiteral("string"));
            inc();
            return;
          }

          if (operator === "~" && t.isNumericLiteral(argument)) {
            path.replaceWith(t.numericLiteral(~argument.value));
            inc();
            return;
          }
        },
      },

      // 条件表达式: true ? a : b → a
      ConditionalExpression: {
        exit(path) {
          const { test, consequent, alternate } = path.node;
          if (t.isBooleanLiteral(test)) {
            path.replaceWith(test.value ? consequent : alternate);
            inc();
            return;
          }
          if (t.isNumericLiteral(test)) {
            path.replaceWith(test.value ? consequent : alternate);
            inc();
            return;
          }
          if (t.isStringLiteral(test)) {
            path.replaceWith(test.value ? consequent : alternate);
            inc();
            return;
          }
        },
      },

      // 逻辑表达式: true && x → x, false || x → x
      LogicalExpression: {
        exit(path) {
          const { left, right, operator } = path.node;

          if (t.isBooleanLiteral(left)) {
            if (operator === "&&") {
              path.replaceWith(left.value ? right : left);
              inc();
              return;
            }
            if (operator === "||") {
              path.replaceWith(left.value ? left : right);
              inc();
              return;
            }
          }
        },
      },
    },
  };
};
