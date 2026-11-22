// The only hosts the server reaches: the regional Roborock sign-in and API hosts
// over REST, the regional brokers over MQTT.
export const REST_HOST = /^(?:(?:eu|us|cn|ru)iot|api-(?:eu|us|cn|ru)(?:-\d+)?)\.roborock\.com$/;
export const MQTT_HOST = /^mqtt-(?:eu|us|cn|ru)(?:-\d+)?\.roborock\.com$/;

// The Xiaomi cloud for vacuums paired with Xiaomi Home: account, sign-in token service
// and regional API.
export const MI_HOST =
  /^(?:account\.xiaomi\.com|(?:(?:de|us|sg|ru|tw|in|i2|sts)\.)?api\.io\.mi\.com|[a-z0-9]+\.fds\.api\.xiaomi\.com)$/;
