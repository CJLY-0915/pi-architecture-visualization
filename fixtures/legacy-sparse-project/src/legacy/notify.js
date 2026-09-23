// Notification helper. Reached through the 'order.create' dispatch key at
// runtime; the only static link is the HTTP client it imports.
import request from 'request';

export function notify(event, payload) {
  return request.post({ uri: event.callback, body: payload });
}
