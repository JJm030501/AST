/**
 * 字符串解密还原插件
 *
 * 处理常见的字符串加密模式：
 * 1. 十六进制字符串还原: "\x48\x65\x6c\x6c\x6f" → "Hello"
 * 2. Unicode 转义还原: "\u0048\u0065\u006c" → "Hel"
 * 3. 字符串数组解密函数还原: _0x1234('0x0') → "actual_string"
 * 4. String.fromCharCode 还原: String.fromCharCode(72,101,108) → "Hel"
 */

const t = require("@babel/types");
const { makeInc } = require("../utils");

function hasLeadingTagComment(node) {
  const comments = node.leadingComments;
  if (!Array.isArray(comments) || comments.length === 0) return false;
  return comments.some((c) => {
    const v = String(c && c.value ? c.value : "");
    return v.includes("[AST] 疑似字符串解密调用");
  });
}

module.exports = function stringDecoder(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "string-decoder",

    visitor: {
      // 还原十六进制 / Unicode 转义的字符串字面量
      StringLiteral(path) {
        const { extra } = path.node;
        if (extra && extra.rawValue !== undefined) {
          // Babel 解析时已经自动还原了转义，确保 raw 和 cooked 一致
          if (extra.raw !== `"${extra.rawValue}"` && extra.raw !== `'${extra.rawValue}'`) {
            path.node.extra = undefined;
            inc();
          }
        }
      },

      // 还原 String.fromCharCode(72, 101, 108, 108, 111) → "Hello"
      CallExpression(path) {
        const { callee, arguments: args } = path.node;

        // String.fromCharCode(...)
        if (
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: "String" }) &&
          t.isIdentifier(callee.property, { name: "fromCharCode" }) &&
          args.every((a) => t.isNumericLiteral(a))
        ) {
          const str = String.fromCharCode(...args.map((a) => a.value));
          path.replaceWith(t.stringLiteral(str));
          inc();
          return;
        }

        // 数组取值型解密函数: _0xabc123('0x0') / _0xabc123(0)
        // 检测模式: 函数名为混淆标识符 + 单参数为字符串或数字
        if (
          t.isIdentifier(callee) &&
          /^_0x[a-f0-9]+$/i.test(callee.name) &&
          args.length === 1 &&
          (t.isStringLiteral(args[0]) || t.isNumericLiteral(args[0]))
        ) {
          // 标记: 需要用户提供解密函数映射表来还原
          // 此处只做标记, 实际还原需要结合动态执行或映射表
          if (!hasLeadingTagComment(path.node)) {
            path.addComment("leading", " [AST] 疑似字符串解密调用, 需动态执行还原 ");
            inc();
          }
        }
      },

      // 还原数组索引访问的字符串: var _arr = ["log","hello"]; console[_arr[0]](_arr[1])
      MemberExpression(path) {
        const { object, property, computed } = path.node;
        if (!computed) return;

        // 尝试解析 arr[0] 模式
        if (t.isIdentifier(object) && t.isNumericLiteral(property)) {
          if (
            path.parentPath &&
            path.parentPath.isAssignmentExpression() &&
            path.parentPath.node.left === path.node
          ) {
            return;
          }

          if (path.parentPath && path.parentPath.isUpdateExpression()) {
            return;
          }

          const binding = path.scope.getBinding(object.name);
          if (!binding) return;

          const init = binding.path.node.init;
          if (t.isArrayExpression(init)) {
            const idx = property.value;
            const elem = init.elements[idx];
            if (elem && t.isStringLiteral(elem)) {
              path.replaceWith(t.stringLiteral(elem.value));
              inc();
            }
          }
        }
      },
    },
  };
};
