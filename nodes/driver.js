"use strict";

const net = require("net");
const tls = require("tls");

const DEFAULT_HOST = "192.168.0.102";
const DEFAULT_PORT = 8891;
const DEFAULT_UID = "nodered";
const DEFAULT_VERSION = "0.1.0";
const DEFAULT_VERSION_API = "1.1";
const DEFAULT_RECONNECT_MS = 5000;

module.exports = function registerOrangeScadaDriver(RED) {
  function OrangeScadaDriver(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    const host = config.host || DEFAULT_HOST;
    const port = Number(config.port || DEFAULT_PORT);
    const ssl = Boolean(config.ssl);
    const uid = config.uid || DEFAULT_UID;
    const version = config.version || DEFAULT_VERSION;
    const versionApi = config.versionApi || DEFAULT_VERSION_API;
    const reconnectMs = Number(config.reconnectMs || DEFAULT_RECONNECT_MS);
    const password =
      node.credentials && node.credentials.password
        ? node.credentials.password
        : "";

    let socket = null;
    let buffer = "";
    let connected = false;
    let stopping = false;
    let reconnectTimer = null;

    function status(fill, shape, text) {
      node.status({ fill, shape, text });
    }

    function send(packet) {
      if (!socket || !connected) return false;
      const data = JSON.stringify(packet);
      socket.write(`${data}\n\r`);
      node.log(`send ${data}`);
      return true;
    }

    function sendConnect() {
      const packet = {
        cmd: "connect",
        uid,
        version,
        versionApi,
        transID: 0,
      };
      if (password) packet.password = password;
      send(packet);
    }

    function reply(request) {
      return send({ cmd: request.cmd, transID: request.transID });
    }

    function errorReply(request, errorTxt) {
      return send({
        cmd: request && request.cmd,
        transID: request && request.transID,
        errorTxt,
      });
    }

    function handlePacket(packet) {
      switch (packet.cmd) {
        case "connect":
          if (packet.errorCode === undefined || packet.errorCode === 0) {
            status("green", "dot", "registered");
          } else {
            status("red", "ring", `connect rejected: ${packet.errorCode}`);
          }
          node.send({ topic: "orangescada/connect", payload: packet });
          return;
        case "pingDriver":
          return reply(packet);
        default:
          return errorReply(packet, "Command not implemented");
      }
    }

    function handleLine(line) {
      try {
        const packet = JSON.parse(line);
        node.log(`recv ${JSON.stringify(packet)}`);
        handlePacket(packet);
      } catch (err) {
        node.error(`OrangeScada JSON parse error: ${err.message}`);
      }
    }

    function handleData(chunk) {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handleLine(line);
        index = buffer.indexOf("\n");
      }
    }

    function scheduleReconnect() {
      if (stopping || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectMs);
    }

    function disconnect() {
      connected = false;
      buffer = "";
      if (socket) {
        socket.destroy();
        socket = null;
      }
    }

    function onConnect() {
      connected = true;
      status("yellow", "dot", "tcp connected");
      sendConnect();
    }

    function connect() {
      if (socket || stopping) return;

      status("yellow", "ring", "connecting");
      socket = ssl
        ? tls.connect({ host, port, rejectUnauthorized: false }, onConnect)
        : net.connect({ host, port }, onConnect);

      socket.on("data", handleData);
      socket.on("close", () => {
        disconnect();
        status("red", "ring", "disconnected");
        scheduleReconnect();
      });
      socket.on("error", (err) => {
        status("red", "ring", "error");
        node.error(err);
      });
    }

    node.on("close", (removed, done) => {
      stopping = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      disconnect();
      status("", "", "");
      done();
    });

    connect();
  }

  RED.nodes.registerType("orangescada-driver", OrangeScadaDriver, {
    credentials: {
      password: { type: "password" },
    },
  });
};

