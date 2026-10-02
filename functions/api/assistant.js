import edgeoneAssistant from '../../cloud-functions/api/assistant.js';

export function onRequest(context) {
  return edgeoneAssistant(context);
}
