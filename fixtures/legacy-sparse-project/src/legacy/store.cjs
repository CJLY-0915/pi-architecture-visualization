// Legacy store module. Reached only through the computed require in
// orders.cjs, so nothing static proves it is ever loaded.
const customers = require('./customers.cjs');

module.exports = {
  findCustomer: (id) => customers.lookup(id),
  save: (record) => ({ saved: record }),
};
