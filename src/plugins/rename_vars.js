/**
 * 混淆变量重命名插件
 *
 * 将混淆风格的标识符重命名为可读形式:
 *   _0x1a2b3c    → _v1, _v2, ...       (普通变量)
 *   _0xabcdef    → _fn1, _fn2, ...     (函数名)
 *   _0x123456    → _p1, _p2, ...       (函数参数)
 *   a0_0xNNNN    → _v3, ...            (a0_0x 变体)
 *   _$NN         → _v4, ...            (下划线美元混淆)
 *   __x / ___x   → _v5, ...            (多下划线混淆)
 *
 * 保守策略: 只重命名局部变量, 不动全局变量和对象属性
 */

const t = require("@babel/types");
const { makeInc } = require("../utils");

// 支持多种混淆命名模式
const OB_PATTERNS = [
  /^_0x[a-f0-9]{4,}$/i,       // _0x1a2b3c (OB 经典)
  /^[a-z]0_0x[a-f0-9]+$/i,    // a0_0xNNNN (变体)
  /^_\$[a-z0-9]{2,}$/i,       // _$xx (美元混淆)
  /^_{3,}[a-z0-9]*$/i,        // ___x (多下划线)
  /^[a-z]{1,2}[a-f0-9]{6,}$/i, // aA1b2c3d (省前缀的 hex 混淆)
];

function isObfuscatedName(name) {
  return OB_PATTERNS.some((p) => p.test(name));
}

module.exports = function renameVariables(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "rename-variables",

    visitor: {
      Program: {
        exit(programPath) {
          let varCount = 0;
          let fnCount = 0;
          let paramCount = 0;
          const renameMap = new Map();

          programPath.traverse({
            Scope(scopePath) {
              const bindings = scopePath.scope.bindings;

              for (const [name, binding] of Object.entries(bindings)) {
                if (!isObfuscatedName(name)) continue;
                if (renameMap.has(name)) continue;

                // 跳过全局作用域的变量(可能被外部引用)
                if (scopePath.isProgram()) continue;

                let prefix;
                const kind = binding.kind;

                if (kind === "param") {
                  paramCount++;
                  prefix = `_p${paramCount}`;
                } else if (
                  binding.path.isFunctionDeclaration() ||
                  (binding.path.isVariableDeclarator() &&
                    t.isFunctionExpression(binding.path.node.init))
                ) {
                  fnCount++;
                  prefix = `_fn${fnCount}`;
                } else {
                  varCount++;
                  prefix = `_v${varCount}`;
                }

                // 使用 scope.generateUid 避免冲突
                const newName = scopePath.scope.generateUid(prefix).replace(/^_+/, "_");

                renameMap.set(name, newName);
                try {
                  scopePath.scope.rename(name, newName);
                  inc();
                } catch (e) {
                  // 某些特殊情况 rename 可能失败, 跳过
                }
              }
            },
          });
        },
      },
    },
  };
};
