// Leaf customer lookup. No dependencies of its own.
module.exports = {
  lookup: (id) => ({ id, tier: 'standard' }),
};
