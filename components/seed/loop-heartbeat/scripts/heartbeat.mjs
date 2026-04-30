const cadenceMinutes = Number(process.env.GARRISON_HEARTBEAT_MINUTES ?? "40");
const gatewayUrl = process.env.GARRISON_GATEWAY_URL ?? "http://127.0.0.1:4777/jobs";

console.log(JSON.stringify({ component: "loop-heartbeat", cadenceMinutes, gatewayUrl }));
