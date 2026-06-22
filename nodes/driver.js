"use strict";

const net = require("net");
const tls = require("tls");

const DEFAULT_HOST = "192.168.0.102";
const DEFAULT_PORT = 8891;
const DEFAULT_UID = "nodered";
const DEFAULT_VERSION = "0.1.0";
const DEFAULT_VERSION_API = "1.1";
const DEFAULT_RECONNECT_MS = 5000;
const MIN_ASYNC_NOTIFY_MS = 1000;
const UNSUPPORTED_EDITOR_COMMAND_ERROR =
  "Command not support, use Node-RED thread editor instead";
const INVALID_COMMAND_ERROR = "Invalid command";

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
    let asyncFlushTimer = null;
    let lastAsyncFlushAt = 0;
    let asyncTransID = 1;
    const tags = new Map();
    const subscriptions = new Map();
    const pendingAsyncValues = new Map();
    const lastAsyncValues = new Map();

    function nextAsyncTransID() {
      const transID = asyncTransID;
      asyncTransID += 1;
      return transID;
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
        version: DEFAULT_VERSION,
        versionApi: DEFAULT_VERSION_API,
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
      const values = getRequestedTagUids(request).map((tagUid) => {
        const item = deviceUid
          ? findTag(deviceUid, tagUid)
          : findTagByUid(tagUid);
        return item ? item.getValue() : null;
      });
      return reply(request, { values });
    }

    function getRequestedTagUids(request) {
      const requestTags = request.tags || [];
      if (!Array.isArray(requestTags)) {
        if (typeof requestTags === "object") return Object.keys(requestTags);
        return [];
      }

      return requestTags.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (item && typeof item === "object" && item.uid) return [item.uid];
        if (item && typeof item === "object" && item.tagUid) {
          return [item.tagUid];
        }
        if (item && typeof item === "object") return Object.keys(item);
        return [];
      });
    }

    function getSetTagValues(request) {
      const requestTags = request.tags || [];

      if (Array.isArray(request.values)) {
        if (!Array.isArray(requestTags)) return [];

        return requestTags.flatMap((item, index) => {
          const tagUid =
            typeof item === "string"
              ? item
              : item && typeof item === "object"
                ? item.uid || item.tagUid
                : null;
          return tagUid ? [{ tagUid, value: request.values[index] }] : [];
        });
      }

      if (!Array.isArray(requestTags)) {
        if (typeof requestTags !== "object") return [];
        return Object.keys(requestTags).map((tagUid) => ({
          tagUid,
          value: requestTags[tagUid],
        }));
      }

      return requestTags.flatMap((item) => {
        if (!item || typeof item !== "object") return [];

        if (item.uid && Object.prototype.hasOwnProperty.call(item, "value")) {
          return [{ tagUid: item.uid, value: item.value }];
        }

        if (
          item.tagUid &&
          Object.prototype.hasOwnProperty.call(item, "value")
        ) {
          return [{ tagUid: item.tagUid, value: item.value }];
        }

        return Object.keys(item).map((tagUid) => ({
          tagUid,
          value: item[tagUid],
        }));
      });
    }

    function valuesEqual(left, right) {
      return Object.is(left, right);
    }

    function getDeviceValues(storage, deviceUid) {
      if (!storage.has(deviceUid)) storage.set(deviceUid, new Map());
      return storage.get(deviceUid);
    }

    function removeDeviceValue(storage, deviceUid, tagUid) {
      const values = storage.get(deviceUid);
      if (!values) return;
      values.delete(tagUid);
      if (values.size === 0) storage.delete(deviceUid);
    }

    function pruneLastAsyncValues(deviceUid) {
      const lastValues = lastAsyncValues.get(deviceUid);
      if (!lastValues) return;

      const subscribed = subscriptions.get(deviceUid);
      Array.from(lastValues.keys()).forEach((tagUid) => {
        if (!subscribed || !subscribed.has(tagUid)) lastValues.delete(tagUid);
      });

      if (lastValues.size === 0) lastAsyncValues.delete(deviceUid);
    }

    function replaceDeviceSubscription(deviceUid, tagUids) {
      if (tagUids.length === 0) {
        subscriptions.delete(deviceUid);
        pendingAsyncValues.delete(deviceUid);
        lastAsyncValues.delete(deviceUid);
        return [];
      }

      const nextSubscription = new Set();
      const nextTags = [];
      tagUids.forEach((tagUid) => {
        if (nextSubscription.has(tagUid)) return;
        const tag = findTag(deviceUid, tagUid);
        if (!tag) return;
        nextSubscription.add(tagUid);
        nextTags.push(tag);
      });

      if (nextSubscription.size > 0) {
        subscriptions.set(deviceUid, nextSubscription);
      } else {
        subscriptions.delete(deviceUid);
      }
      pendingAsyncValues.delete(deviceUid);
      pruneLastAsyncValues(deviceUid);
      return nextTags;
    }

    function sendAsyncValues(deviceUid, values) {
      return send({
        cmd: "asyncTagsValues",
        transID: nextAsyncTransID(),
        deviceUid,
        values,
      });
    }

    function sendSubscriptionSnapshot(subscribedTags) {
      const valuesByDevice = new Map();

      subscribedTags.forEach((tag) => {
        const value = tag.getValue();
        const lastValues = lastAsyncValues.get(tag.device.uid);
        const hasLastValue = Boolean(lastValues && lastValues.has(tag.uid));
        if (hasLastValue && valuesEqual(value, lastValues.get(tag.uid))) {
          return;
        }

        const values = getDeviceValues(valuesByDevice, tag.device.uid);
        values.set(tag.uid, value);
      });

      valuesByDevice.forEach((valuesByTag, deviceUid) => {
        const values = {};
        valuesByTag.forEach((value, tagUid) => {
          values[tagUid] = value;
        });

        if (!sendAsyncValues(deviceUid, values)) return;

        const lastValues = getDeviceValues(lastAsyncValues, deviceUid);
        valuesByTag.forEach((value, tagUid) => {
          lastValues.set(tagUid, value);
        });
        lastAsyncFlushAt = Date.now();
      });
    }

    function replaceAllSubscriptions(tagUids) {
      if (tagUids.length === 0) {
        subscriptions.clear();
        pendingAsyncValues.clear();
        lastAsyncValues.clear();
        return [];
      }

      const tagUidsByDevice = new Map();
      tagUids.forEach((tagUid) => {
        const tag = findTagByUid(tagUid);
        if (!tag) return;
        getDeviceValues(tagUidsByDevice, tag.device.uid).set(tag.uid, true);
      });

      Array.from(subscriptions.keys()).forEach((deviceUid) => {
        if (tagUidsByDevice.has(deviceUid)) return;
        subscriptions.delete(deviceUid);
        pendingAsyncValues.delete(deviceUid);
        lastAsyncValues.delete(deviceUid);
      });

      return Array.from(tagUidsByDevice.entries()).flatMap(
        ([deviceUid, valuesByTag]) =>
          replaceDeviceSubscription(deviceUid, Array.from(valuesByTag.keys())),
      );
    }

    function handleSetTagsSubscribe(request) {
      const tagUids = getRequestedTagUids(request);
      const deviceUid = request.deviceUid || request.uid;

      if (deviceUid) {
        const subscribedTags = replaceDeviceSubscription(deviceUid, tagUids);
        const result = reply(request);
        sendSubscriptionSnapshot(subscribedTags);
        return result;
      }

      const subscribedTags = replaceAllSubscriptions(tagUids);
      const result = reply(request);
      sendSubscriptionSnapshot(subscribedTags);
      return result;
    }

    function handleSetTagsValues(request) {
      const deviceUid = request.deviceUid || request.uid;
      if (deviceUid && !findDevice(deviceUid)) {
        return errorReply(request, "Device ID not found");
      }

      const tagValues = getSetTagValues(request);
      const writes = tagValues.map((item) => ({
        tag: deviceUid
          ? findTag(deviceUid, item.tagUid)
          : findTagByUid(item.tagUid),
        value: item.value,
      }));

      const missing = writes.find((item) => !item.tag);
      if (missing) return errorReply(request, "ID not found");

      writes.forEach((item) => {
        item.tag.writeValue(item.value);
      });

      return reply(request);
    }

    function isSubscribed(tag) {
      const subscribed = subscriptions.get(tag.device.uid);
      return Boolean(subscribed && subscribed.has(tag.uid));
    }

    function scheduleAsyncFlush() {
      if (asyncFlushTimer || pendingAsyncValues.size === 0) return;

      const elapsed = Date.now() - lastAsyncFlushAt;
      const delay = Math.max(0, MIN_ASYNC_NOTIFY_MS - elapsed);
      asyncFlushTimer = setTimeout(flushAsyncValues, delay);
    }

    function bufferAsyncValue(tag) {
      if (!isSubscribed(tag)) return;

      const value = tag.getValue();
      const lastValues = lastAsyncValues.get(tag.device.uid);
      const hasLastValue = Boolean(lastValues && lastValues.has(tag.uid));

      if (hasLastValue && valuesEqual(value, lastValues.get(tag.uid))) {
        removeDeviceValue(pendingAsyncValues, tag.device.uid, tag.uid);
        return;
      }

      getDeviceValues(pendingAsyncValues, tag.device.uid).set(tag.uid, value);
      scheduleAsyncFlush();
    }

    function flushAsyncValues() {
      asyncFlushTimer = null;
      if (!connected || pendingAsyncValues.size === 0) return;

      pendingAsyncValues.forEach((valuesByTag, deviceUid) => {
        const values = {};
        valuesByTag.forEach((value, tagUid) => {
          values[tagUid] = value;
        });

        if (!sendAsyncValues(deviceUid, values)) return;

        const lastValues = getDeviceValues(lastAsyncValues, deviceUid);
        valuesByTag.forEach((value, tagUid) => {
          lastValues.set(tagUid, value);
        });
      });

      pendingAsyncValues.clear();
      lastAsyncFlushAt = Date.now();
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
        case "setNode":
        case "addNode":
        case "deleteNode":
          return errorReply(packet, UNSUPPORTED_EDITOR_COMMAND_ERROR);
        case "getDevices":
          return reply(packet, {
            devices: getDevices(packet.nodeUid || packet.uid),
          });
        case "pingDevice":
          return reply(packet, { active: Boolean(findDevice(packet.uid)) });
        case "getDevice":
          return handleGetDevice(packet);
        case "setDevice":
        case "addDevice":
        case "deleteDevice":
          return errorReply(packet, UNSUPPORTED_EDITOR_COMMAND_ERROR);
        case "getTags":
          return reply(packet, {
            tags: getTags(packet.deviceUid, packet.isOptions),
          });
        case "getTag":
          return handleGetTag(packet);
        case "setTag":
        case "addTag":
        case "deleteTag":
          return errorReply(packet, UNSUPPORTED_EDITOR_COMMAND_ERROR);
        case "getTagsValues":
          return handleGetTagsValues(packet);
        case "setTagsValues":
          return handleSetTagsValues(packet);
        case "setTagsSubscribe":
          return handleSetTagsSubscribe(packet);
        case "asyncTagsValues":
          return;
        default:
          return errorReply(packet, INVALID_COMMAND_ERROR);
      }
    }

    function handleLine(line) {
      let packet;
      try {
        packet = JSON.parse(line);
      } catch (err) {
        node.error(`OrangeScada JSON parse error: ${err.message}`);
        return;
      }

      node.log(`recv ${JSON.stringify(packet)}`);
      Promise.resolve()
        .then(() => handlePacket(packet))
        .catch((err) => {
          node.error(`OrangeScada command error: ${err.message}`);
          errorReply(packet, err.message);
        });
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
      subscriptions.clear();
      pendingAsyncValues.clear();
      lastAsyncValues.clear();
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
      if (asyncFlushTimer) clearTimeout(asyncFlushTimer);
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
      const tag = tags.get(id);
      if (tag) {
        const subscribed = subscriptions.get(tag.device.uid);
        if (subscribed) {
          subscribed.delete(tag.uid);
          if (subscribed.size === 0) subscriptions.delete(tag.device.uid);
        }

        const pending = pendingAsyncValues.get(tag.device.uid);
        if (pending) {
          pending.delete(tag.uid);
          if (pending.size === 0) pendingAsyncValues.delete(tag.device.uid);
        }

        removeDeviceValue(lastAsyncValues, tag.device.uid, tag.uid);
      }
      tags.delete(id);
    };
    node.notifyTagValueChanged = function notifyTagValueChanged(id) {
      const tag = tags.get(id);
      if (!tag) return;
      bufferAsyncValue(tag);
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

    function sendWriteMessage(value) {
      node.send({
        payload: normalizeValue(node.tagType, value),
        orangescada: buildMeta(),
      });
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
        writeValue: sendWriteMessage,
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
      if (node.driver) node.driver.notifyTagValueChanged(node.id);
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
