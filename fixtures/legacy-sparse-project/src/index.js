// Legacy order entrypoint. Requests are dispatched through a string-keyed
// handler table wired at runtime; the keys are contract strings no type
// system checks and no static importer resolves.
const handlers = {
  'order.create': (payload) => require('./legacy/orders.cjs').create(payload),
  'order.refund': (payload) => require('./legacy/orders.cjs').refund(payload),
};

// Hardcoded upstream host: no config service and no environment override.
const UPSTREAM = 'http://10.0.0.7:8080';

// Boot-time route selection. The handler module is chosen by an environment
// variable and loaded on demand, so what actually runs is invisible here.
const route = process.env.ORDER_ROUTE || 'order.create';

function loadRoute(routeVar) {
  return require(routeVar);
}

module.exports = { handlers, UPSTREAM, loadRoute, route };
