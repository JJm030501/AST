/**
 * 十六进制数字还原插件
 *
 * 将混淆代码中的十六进制数字字面量还原为十进制:
 *   0x1a2b → 6699
 *   0xff   → 255
 *   0x0    → 0
 *
 * obfuscator 经常将所有数字转为 hex 增加阅读难度
 */

const t = require("@babel/types");
const { makeInc } = require("../utils");

module.exports = function hexNumberRestorer(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "hex-number-restorer",

    visitor: {
      NumericLiteral(path) {
        const { extra } = path.node;
        // Babel 解析后 extra.raw 保留了原始写法
        // 如果原始写法是 0x 开头, 清除 extra 让 generator 输出十进制
        if (extra && typeof extra.raw === "string" && /^0[xXoObB]/.test(extra.raw)) {
          path.node.extra = undefined;
          inc();
        }
      },
    },
  };
};
