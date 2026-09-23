// Legacy CommonJS order module. The dependency is loaded through a variable,
// so no static importer can see what it pulls in.
function loadDep(expr) {
  return require(expr);
}

module.exports = {
  create: (payload) => loadDep('./store')(payload),
  refund: (payload) => loadDep('./store')(payload),
};
