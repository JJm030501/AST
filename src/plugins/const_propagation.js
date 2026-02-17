const t = require("@babel/types");
const { isSafeConst, removeDeclaratorAndCleanup, makeInc } = require("../utils");

function canReplaceRef(refPath) {
  if (!refPath.isIdentifier()) return false;
  if (!refPath.isReferencedIdentifier()) return false;

  if (refPath.parentPath && refPath.parentPath.isObjectProperty({ shorthand: true })) {
    return false;
  }

  if (refPath.parentPath && refPath.parentPath.isExportSpecifier()) {
    return false;
  }

  return true;
}

module.exports = function constPropagation(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "const-propagation",

    visitor: {
      VariableDeclarator: {
        exit(path) {
          const { id, init } = path.node;
          if (!t.isIdentifier(id)) return;
          if (!isSafeConst(init)) return;

          const binding = path.scope.getBinding(id.name);
          if (!binding) return;
          if (!binding.constant) return;
          if (!binding.referencePaths || binding.referencePaths.length === 0) return;

          for (const ref of binding.referencePaths) {
            if (!canReplaceRef(ref)) return;
          }

          for (const ref of binding.referencePaths) {
            ref.replaceWith(t.cloneNode(init, true));
            inc();
          }

          removeDeclaratorAndCleanup(path, inc);
        },
      },
    },
  };
};
