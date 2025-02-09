import { createStore } from "vuex"
import { Asset, Pair } from "@/models"

// Decode function for hex dump: for bridge
// function decode(hex) {
//   const bytes = [];

//   for (let i = 0; i < hex.length - 1; i += 2)
//     bytes.push(parseInt(hex.substr(i, 2), 16));

//   return String.fromCharCode.apply(String, bytes);
// }

export default createStore({
  state: {
    pairs: [],
    websocket: null,
    messageHandlers: {},
    currentRequestId: 1,
    connectionState: 0, // 3 = refused, 2 = connected, 1 = waiting authorization, 0 = unknown, -1 = xswd server not running
    address: "",
    userBalances: {},

    toastText: "",

    pendingRequestsPerms: {},
    refusedPermissions: {},

    assets: {},
  },
  getters: {
    assetsByScid(state) {
      const newPairs = {}
      Object.values(state.assets).forEach((p) => {
        newPairs[p.scid] = p;
      })
      return newPairs;
    }
  },
  mutations: {
    setMessageHandler(state, {key, handler}) {
      state.messageHandlers[key] = handler;
    },
    removeMessageHandler(state, key) {
      delete state.messageHandlers[key];
    }
  },
  actions: {
    async start(store) {
      await store.dispatch("openWebSocket").catch((e) => {
        console.error(e);
        store.dispatch("displayToast", "Error while connecting to the XSWD Server, is it running ?");
      });
      await store.dispatch("getAddress");
    },
    displayToast(store, text) {
      store.state.toastText = text;
      setTimeout(() => {
        store.state.toastText = null;
      }, 10000)
    },
    openWebSocket(store) {
      return new Promise((resolve, reject) => {
        /**
         * 1. Initiates the WebSocket
         * 2. When opened, asks the authorization
         * 3. Waits for the accept message
         * 4. Resolves
         */
        try {
          store.state.websocket = new WebSocket("ws://localhost:44326/xswd");
        } catch (e) {
          reject(e);
          return;
        }
  
        store.state.websocket.onmessage = (message) => {
          const data = JSON.parse(message.data)
          Object.values(store.state.messageHandlers).forEach((handler) => {
            handler(data);
          });

          if (data.accepted === true) {
            store.state.connectionState = 2;
            resolve()
          } else if (data.accepted === false) {
            store.state.connectionState = 3;
            resolve()
          }
        };
    
        store.state.websocket.onerror = (error) => {
          store.state.connectionState = -1;
          console.error(error);
          store.dispatch("displayToast", "An error has occured with XSWD");
        };
  
        store.state.websocket.onopen = () => {
          store.dispatch("askAppAuthorization");
          store.state.connectionState = 1;
        };

        store.state.websocket.onclose = () => {
          if (store.state.connectionState > 0) {
            store.state.connectionState = -1;
          }
        };
      })
    },
    askAppAuthorization(store) {
      return store.state.websocket.send(JSON.stringify({
        "id": "ed606a2f4c4f499618a78ff5f7c8e51cd2ca4d8bfa7e2b41a27754bb78b1df1f",
        "name": "DEROSwap",
        "description": "DEROSwap allows you to easily swap any token on DERO chain",
        "url": window.location.origin,
      }))
    },
    sendRpc(store, { method, id, params }) {
      return store.state.websocket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }))
    },
    sendRpcAndWait(store, { method, params }) {
      /**
       * Create a promise where we add a message handler, then send a request and resolve the promise only when a
       * message with the same id is received, then remove the message handler
       */
      const currentId = store.state.currentRequestId;
      const keyHandler = `req${currentId}`

      let timeout = null;

      return new Promise((resolve) => {
        store.commit("setMessageHandler", {
            key: keyHandler,
            handler(message) {
              if (message.id == currentId) {
                if (timeout) {
                  clearTimeout(timeout)
                }

                if (!method.startsWith("DERO")) {
                  if ([-32044, -32043, -32601].includes(message.error?.code)) {
                    store.state.refusedPermissions[method] = false;
                  }
                }
                else {
                  if (message.error?.code == -32601) {
                    store.state.websocket.close()
                    return false;
                  }
                }
                resolve(message.result || message.error);
                delete store.state.pendingRequestsPerms[currentId]
                store.commit("removeMessageHandler", keyHandler);
              }
            }
        });
        store.dispatch("sendRpc", {
          method,
          id: currentId,
          params,
        });
        
        if (!method.startsWith("DERO")) {  // daemon doesn't need perm
          timeout = setTimeout(() => {
            store.state.pendingRequestsPerms[currentId] = method
          }, 2000)
        }

        store.state.currentRequestId += 1;
      });
    },
    getMainScid(store) {
      /**
       * Get the three keys for dex.bridge.erc20, dex.swap.registry and dex.bridge.registry
       * Used to get the swap pairs, for example.
       */
      return store.dispatch("sendRpcAndWait", {
        method: "DERO.GetSC",
        params: {
          scid: '0000000000000000000000000000000000000000000000000000000000000001', // keystore scid
          keysstring: ["keystore"],
        }
      }).then((sc) => {
        console.log(sc);
        let keystoreScid = sc.valuesstring[0];
        keystoreScid = "80" + keystoreScid.substring(2, 64);

        const baseKeys = [
          // "k:dex.bridge.erc20", // encoded Ethereum bridge address
          "k:dex.swap.registry", // dex registry address
          // "k:dex.bridge.registry", // reverse bridge registry 
        ];
        
        return store.dispatch("sendRpcAndWait", {
          method: "DERO.GetSC",
          params: {
            scid: keystoreScid,
            keysstring: baseKeys,
          }
        }).then((keystores) => {
          // store.state.ercBridgeKey = decode(keystores.valuesstring[0]); // Utility of decode ?
          // store.state.swapKey = keystores.valuesstring[1];
          store.state.swapKey = keystores.valuesstring[0];
          // store.state.bridgeKey = keystores.valuesstring[2];
          return true;
        })
      })
    },
    async getSwapPairs(store) {
      /**
       * Get and save the pairs from dex.swap.registry
       */

      let scid = store.state.swapKey;

      // We need the dex.swap.registry to retrieve swap pairs
      if (!scid) {
        await store.dispatch("getMainScid");
        scid = store.state.swapKey;
      }
      
      return store.dispatch("sendRpcAndWait", {
        method: "DERO.GetSC",
        params: {
          scid,
          code: false,
          variables: true,
        }
      }).then((result) => {

        // ========================== NEW2 ==========================
        // ========================== END NEW2 ==========================
        const assetsList = {};
        const pairs = [];

        // Reversed so we can create assetsList before getting pairs
        Object.entries(result.stringkeys).reverse()
        .filter(([key]) => key.startsWith("t:") || key.startsWith("p:"))
        .map(([key, value]) => {
          const assetName = key.split(":")[1];
          
          if (!assetsList[assetName]) {
            assetsList[assetName] = new Asset(assetName);
          }

          if (key.startsWith("t:") && key.endsWith(":d")) {
            // Digits starts with t: and ends with :d
            assetsList[assetName].digit = value;
          } else if (key.startsWith("t:") && key.endsWith(":c")) {
            // Asset scid starts with t: and ends with :c
            assetsList[assetName].scid = value;
          } else if (key.startsWith("p:")) {
            const [name1, name2] = key.substring(2).split(":");

            pairs.push(new Pair(
              value, assetsList[name1], assetsList[name2]
            ))
          }
        })
        store.state.assets = assetsList;
        store.state.pairs = pairs;
        

        // Contract balances
        let promisesCB = store.state.pairs.map((p) => {
          const params = {
            scid: p.contract,
            code: false,
            variables: true,
          };
          return store.dispatch(
            "sendRpcAndWait",
            { method: "DERO.GetSC", params}
          ).then((t) => {
            const sk = t.stringkeys;
            // p.fromRealValue = sk.val1 / Math.pow(10, p.asset1.digit);
            // p.toRealValue = sk.val2 / Math.pow(10, p.assets2.digit);
            p.val1 = sk.val1
            p.val2 = sk.val2
            p.fees = sk.fee;
          })
        })

        // User balances
        let promisesUB = Object.values(store.state.assets).map((a) => {
          const params = {
            scid: a.scid,
          };
          return store.dispatch(
            "sendRpcAndWait",
            { method: "GetBalance", params}
          ).then((res) => {
            a.atomicBalance = res?.balance;
          })
        })

        return Promise.all([...promisesCB, ...promisesUB]).then(() => store.state.pairs);
      })
    },
    getAddress(store) {
      return store.dispatch("sendRpcAndWait", { method: "GetAddress" }).then((res) => {
        if (res?.address) {
          store.state.address = res.address;
        }
      })
    },
    getRandomAddress(store) {
      return store.dispatch("sendRpcAndWait", { method: "DERO.GetRandomAddress" })
    },
    async getEstimatedSwapGasFees(store, { asset1, atomicAmountFrom, pairScId }) {
      const randomAddress = (await store.dispatch("getRandomAddress")).address[0]

      const params = {
        sc_rpc: [
          { name: "entrypoint", datatype: "S", value: "Swap" },
          { name: "SC_ID", datatype: "H", value: pairScId },
          { name: "SC_ACTION", datatype: "U", value: 0 },
        ],
        transfers: [
          { scid: asset1.scid, destination: randomAddress, burn: atomicAmountFrom },
        ],
        signer: store.state.address,
      };

      const gasEstimate = await store.dispatch(
        "sendRpcAndWait", {
          method: "DERO.GetGasEstimate", params
      })
      return gasEstimate.gasstorage/ 100000
    },
    async getEstimatedPoolAddGasFees(store, { pair, atomicAmountFrom, atomicAmountTo }) {
      const randomAddress = (await store.dispatch("getRandomAddress")).address[0]

      console.log(pair);
      const params = {
        sc_rpc: [
          { name: "entrypoint", datatype: "S", value: "AddLiquidity" },
          { name: "SC_ID", datatype: "H", value: pair.contract },
          { name: "SC_ACTION", datatype: "U", value: 0 },
        ],
        transfers: [
          { scid: pair.asset1.scid, destination: randomAddress, burn: atomicAmountFrom },
          { scid: pair.asset2.scid, destination: randomAddress, burn: atomicAmountTo },
        ],
        signer: store.state.address,
      };

      const gasEstimate = await store.dispatch(
        "sendRpcAndWait", {
          method: "DERO.GetGasEstimate", params
      })
      return gasEstimate.gasstorage / 100000
    },
    async swap(store, { asset1, atomicAmountFrom, pairScId }) {
      const randomAddress = (await store.dispatch("getRandomAddress")).address[0];
      const fees = await store.dispatch("getEstimatedSwapGasFees", {
        asset1, atomicAmountFrom, pairScId
      }) * 100000;

      const params = {
        scid: pairScId,
        ringsize: 2,
        sc_rpc: [{ name: "entrypoint", datatype: "S", value: "Swap" }],
        transfers: [
          { scid: asset1.scid, destination: randomAddress, burn: atomicAmountFrom },
        ],
        fees,
      };

      return await store.dispatch(
        "sendRpcAndWait", {
          method: "transfer", params
      })
    },
    async poolAdd(store, { pair, atomicAmountFrom, atomicAmountTo, }) {
      const randomAddress = (await store.dispatch("getRandomAddress")).address[0];
      const fees = await store.dispatch("getEstimatedPoolAddGasFees", {
        pair, atomicAmountFrom, atomicAmountTo
      }) * 100000;

      const params = {
        scid: pair.contract,
        ringsize: 2,
        sc_rpc: [{ name: "entrypoint", datatype: "S", value: "AddLiquidity" }],
        transfers: [
          {
            scid: pair.asset1.scid,
            destination: randomAddress,
            burn: atomicAmountFrom,
          },
          {
            scid: pair.asset2.scid,
            destination: randomAddress,
            burn: atomicAmountTo,
          },
        ],
        fees,
      };

      return await store.dispatch(
        "sendRpcAndWait", {
          method: "transfer", params
      });
    }
  },
})
