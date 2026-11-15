// Only the Roborock hosts the app talks to may be reached through the relays,
// so they can't be abused as an open proxy: the regional sign-in and API hosts
// over REST, the regional brokers over MQTT.
export const REST_HOST = /^(?:(?:eu|us|cn|ru)iot|api-(?:eu|us|cn|ru)(?:-\d+)?)\.roborock\.com$/;
export const MQTT_HOST = /^mqtt-(?:eu|us|cn|ru)(?:-\d+)?\.roborock\.com$/;
