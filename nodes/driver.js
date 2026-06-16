"use strict";

const net = require("net");
const tls = require("tls");

const DEFAULT_HOST = "192.168.0.102";
const DEFAULT_PORT = 8891;
const DEFAULT_UID = "nodered";
const DEFAULT_VERSION = "0.1.0";
const DEFAULT_VERSION_API = "1.1";
const DEFAULT_RECONNECT_MS = 5000;

module.exports = function registerOrangeScadaNodes(RED) {
  function normalizeValue(type, value) {
    if (value === null || value === undefined) return null;

    switch (type) {
      case "bool":
        if (typeof value === "string") {
          return value === "true" || value === "1";
        }
        return Boolean(value);
      case "int": {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? Math.trunc(numberValue) : null;
      }
      case "float": {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? numberValue : null;
      }
      case "string":
        return String(value);
      default:
        return value;
    }
  }

  function driverConfig(config) {
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
    const tags = new Map();

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

    function reply(request, data) {
      return send(
        Object.assign(
          { cmd: request.cmd, transID: request.transID },
          data || {},
        ),
      );
    }

    function errorReply(request, errorTxt) {
      return send({
        cmd: request && request.cmd,
        transID: request && request.transID,
        errorTxt,
      });
    }

    function uniqueByUid(items) {
      return Array.from(
        items
          .filter((item) => item && item.uid)
          .reduce((acc, item) => {
            if (!acc.has(item.uid)) acc.set(item.uid, item);
            return acc;
          }, new Map())
          .values(),
      );
    }

    function findNode(uid) {
      return uniqueByUid(Array.from(tags.values()).map((tag) => tag.node)).find(
        (item) => item.uid === uid,
      );
    }

    function findDevice(uid) {
      return uniqueByUid(
        Array.from(tags.values()).map((tag) => tag.device),
      ).find((item) => item.uid === uid);
    }

    function findTag(deviceUid, tagUid) {
      return Array.from(tags.values()).find(
        (tag) => tag.device.uid === deviceUid && tag.uid === tagUid,
      );
    }

    function findTagByUid(tagUid) {
      return Array.from(tags.values()).find((tag) => tag.uid === tagUid);
    }

    function hasTag(tagUid) {
      return Array.from(tags.values()).some((tag) => tag.uid === tagUid);
    }

    function hasNodeUid(nodeUid, nodeId) {
      return Array.from(tags.values()).some(
        (tag) => tag.node.uid === nodeUid && tag.node.id !== nodeId,
      );
    }

    function hasDeviceUid(deviceUid, deviceId) {
      return Array.from(tags.values()).some(
        (tag) => tag.device.uid === deviceUid && tag.device.id !== deviceId,
      );
    }

    function getNodes() {
      return uniqueByUid(Array.from(tags.values()).map((tag) => tag.node)).map(
        (item) => ({
          uid: item.uid,
          name: item.name,
        }),
      );
    }

    function getDevices(nodeUid) {
      return uniqueByUid(
        Array.from(tags.values())
          .filter((tag) => !nodeUid || tag.node.uid === nodeUid)
          .map((tag) => tag.device),
      ).map((item) => ({
        uid: item.uid,
        name: item.name,
        nodeUid: item.nodeUid,
      }));
    }

    function getTags(deviceUid, includeOptions) {
      return Array.from(tags.values())
        .filter((tag) => tag.device.uid === deviceUid)
        .map((tag) => {
          const item = {
            uid: tag.uid,
            name: tag.name,
            address: tag.address,
            type: tag.type,
            read: true,
            write: true,
          };
          if (includeOptions) item.options = {};
          return item;
        });
    }

    function handleGetNode(request) {
      if (!request.uid) return reply(request, { options: [] });
      const item = findNode(request.uid);
      if (!item) return errorReply(request, "ID not found");
      return reply(request, { name: item.name, options: [] });
    }

    function handleGetDevice(request) {
      if (!request.uid) return reply(request, { options: [] });
      const item = findDevice(request.uid);
      if (!item) return errorReply(request, "ID not found");
      return reply(request, { name: item.name, options: [] });
    }

    function handleGetTag(request) {
      if (!request.deviceUid) return errorReply(request, "Device ID not found");
      if (!request.uid) return reply(request, { options: [] });
      const item = findTag(request.deviceUid, request.uid);
      if (!item) return errorReply(request, "ID not found");
      return reply(request, {
        name: item.name,
        address: item.address,
        type: item.type,
        read: true,
        write: true,
        options: [],
      });
    }

    function handleGetTagsValues(request) {
      const deviceUid = request.deviceUid || request.uid;
      const values = (request.tags || []).map((tagUid) => {
        const item = deviceUid
          ? findTag(deviceUid, tagUid)
          : findTagByUid(tagUid);
        return item ? item.getValue() : null;
      });
      return reply(request, { values });
    }

    function handlePacket(packet) {
      switch (packet.cmd) {
        case "connect":
          if (packet.errorCode === undefined || packet.errorCode === 0) {
            node.log("registered");
          } else {
            node.error(`connect rejected: ${packet.errorCode}`);
          }
          return;
        case "pingDriver":
          return reply(packet);
        case "getNodes":
          return reply(packet, { nodes: getNodes() });
        case "pingNode":
          return reply(packet, { active: Boolean(findNode(packet.uid)) });
        case "getNode":
          return handleGetNode(packet);
        case "getDevices":
          return reply(packet, {
            devices: getDevices(packet.nodeUid || packet.uid),
          });
        case "pingDevice":
          return reply(packet, { active: Boolean(findDevice(packet.uid)) });
        case "getDevice":
          return handleGetDevice(packet);
        case "getTags":
          return reply(packet, {
            tags: getTags(packet.deviceUid, packet.isOptions),
          });
        case "getTag":
          return handleGetTag(packet);
        case "getTagsValues":
          return handleGetTagsValues(packet);
        default:
          return errorReply(packet, "Command not implemented");
      }
    }

    function handleLine(line) {
      try {
        const packet = JSON.parse(line);
        node.log(`recv ${JSON.stringify(packet)}`);
        Promise.resolve(handlePacket(packet)).catch((err) => {
          node.error(`OrangeScada command error: ${err.message}`);
          errorReply(packet, err.message);
        });
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
      node.log(`tcp connected ${host}:${port}`);
      sendConnect();
    }

    function connect() {
      if (socket || stopping) return;

      socket = ssl
        ? tls.connect({ host, port, rejectUnauthorized: false }, onConnect)
        : net.connect({ host, port }, onConnect);

      socket.on("data", handleData);
      socket.on("close", () => {
        disconnect();
        scheduleReconnect();
      });
      socket.on("error", (err) => {
        node.error(err);
      });
    }

    node.on("close", (removed, done) => {
      stopping = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      disconnect();
      done();
    });

    node.driverUid = uid;
    node.hasTag = hasTag;
    node.hasNodeUid = hasNodeUid;
    node.hasDeviceUid = hasDeviceUid;
    node.registerTag = function registerTag(tag) {
      tags.set(tag.id, tag);
    };
    node.unregisterTag = function unregisterTag(id) {
      tags.delete(id);
    };
    setTimeout(connect, 0);
  }

  function nodeConfig(config) {
    RED.nodes.createNode(this, config);
    this.uid = config.uid || config.id;
    this.name = config.name;
    this.driver = config.driver;
  }

  function deviceConfig(config) {
    RED.nodes.createNode(this, config);
    this.uid = config.uid || config.id;
    this.name = config.name;
    this.node = config.node;
  }

  function tag(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    node.driver = RED.nodes.getNode(config.driver);
    node.commNode = RED.nodes.getNode(config.node);
    node.device = RED.nodes.getNode(config.device);
    node.tagUid = config.tagUid || config.id;
    node.tagName = config.tagName;
    node.tagType = config.tagType;
    node.address = Number(config.address || 0);
    node.currentValue = null;

    function buildMeta() {
      return {
        driver: node.driver && node.driver.driverUid,
        node: node.commNode && node.commNode.uid,
        device: node.device && node.device.uid,
        tag: node.tagUid,
        type: node.tagType,
      };
    }

    if (node.driver && node.commNode && node.device) {
      if (node.driver.hasNodeUid(node.commNode.uid, node.commNode.id)) {
        node.warn(
          `duplicate node uid "${node.commNode.uid}", fix the copied config node before deploying`,
        );
      }

      if (node.driver.hasDeviceUid(node.device.uid, node.device.id)) {
        node.warn(
          `duplicate device uid "${node.device.uid}", fix the copied config node before deploying`,
        );
      }

      if (node.driver.hasTag(node.tagUid)) {
        node.warn(
          `duplicate tag uid "${node.tagUid}", using node id "${node.id}"`,
        );
        node.tagUid = node.id;
      }

      node.driver.registerTag({
        id: node.id,
        uid: node.tagUid,
        name: node.tagName,
        type: node.tagType,
        address: node.address,
        getValue: () => node.currentValue,
        node: {
          id: node.commNode.id,
          uid: node.commNode.uid,
          name: node.commNode.name,
        },
        device: {
          id: node.device.id,
          uid: node.device.uid,
          name: node.device.name,
          nodeUid: node.commNode.uid,
        },
      });
    }

    node.on("input", (msg, send, done) => {
      node.currentValue = normalizeValue(node.tagType, msg.payload);
      msg.orangescada = buildMeta();
      send(msg);
      if (done) done();
    });

    node.on("close", (removed, done) => {
      if (node.driver) node.driver.unregisterTag(node.id);
      done();
    });
  }

  RED.nodes.registerType("orangescada-driver-config", driverConfig, {
    credentials: {
      password: { type: "password" },
    },
  });
  RED.nodes.registerType("orangescada-node-config", nodeConfig);
  RED.nodes.registerType("orangescada-device-config", deviceConfig);
  RED.nodes.registerType("orangescada-tag", tag);
};
