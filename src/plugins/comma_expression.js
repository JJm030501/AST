/**
 * 逗号表达式拆分插件
 *
 * 将混淆代码中的逗号表达式拆分为独立语句:
 *
 * 混淆前:
 *   a = 1, b = 2, c = 3;
 *   return a = 1, b = 2, c;
 *
 * 还原后:
 *   a = 1;
 *   b = 2;
 *   c = 3;
 *
 *   a = 1;
 *   b = 2;
 *   return c;
 *
 * obfuscator 经常将多条语句用逗号合并为一条, 增加阅读难度
 */

const t = require("@babel/types");
const { makeInc } = require("../utils");

module.exports = function commaExpressionSplitter(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "comma-expression-splitter",

    visitor: {
      // 处理 ExpressionStatement 中的逗号表达式: a = 1, b = 2, c = 3;
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!t.isSequenceExpression(expr)) return;

        const statements = expr.expressions.map((e) => t.expressionStatement(e));
        path.replaceWithMultiple(statements);
        inc();
      },

      // 处理 return 中的逗号表达式: return a = 1, b = 2, value;
      ReturnStatement(path) {
        const arg = path.node.argument;
        if (!arg || !t.isSequenceExpression(arg)) return;

        const expressions = arg.expressions;
        if (expressions.length < 2) return;

        // 前面的表达式变成独立语句, 最后一个留给 return
        const beforeStatements = expressions
          .slice(0, -1)
          .map((e) => t.expressionStatement(e));
        const lastExpr = expressions[expressions.length - 1];
        const returnStmt = t.returnStatement(lastExpr);

        path.replaceWithMultiple([...beforeStatements, returnStmt]);
        inc();
      },

      // 处理 if 条件中的逗号表达式: if(a = 1, b = 2, condition) { ... }
      IfStatement(path) {
        const test = path.node.test;
        if (!t.isSequenceExpression(test)) return;

        const expressions = test.expressions;
        if (expressions.length < 2) return;

        const beforeStatements = expressions
          .slice(0, -1)
          .map((e) => t.expressionStatement(e));
        const lastExpr = expressions[expressions.length - 1];

        path.node.test = lastExpr;
        // 在 if 前插入前置语句
        for (let i = beforeStatements.length - 1; i >= 0; i--) {
          path.insertBefore(beforeStatements[i]);
        }
        inc();
      },
    },
  };
};
