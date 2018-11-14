const utils = require('../../utils/utils.js');
const fs = require('../../core/fs');

class ConsoleListener {
  constructor(embark, options) {
    this.embark = embark;
    this.logger = embark.logger;
    this.ipc = options.ipc;
    this.events = embark.events;
    this.addressToContract = [];
    this.contractsConfig = embark.config.contractsConfig;
    this.contractsDeployed = false;
    this.outputDone = false;
    this.logFile = fs.dappPath(".embark", "contractLogs.json");
    fs.ensureFileSync(this.logFile);
    this.logFileDraining = true;
    this.logFileQueue = [];
    this.logFileReading = 0;
    this.logFileWriting = false;
    this.logFileWriteStream = require('fs').createWriteStream(this.logFile);

    this._listenForLogRequests();
    this._registerAPI();

    this.events.on("contracts:log", this._saveLog.bind(this));
    this.events.on('outputDone', () => {
      this.outputDone = true;
    });
    this.events.on("contractsDeployed", () => {
      this.contractsDeployed = true;
      this._updateContractList();
    });
  }

  _updateContractList() {
    this.events.request("contracts:list", (_err, contractsList) => {
      if (_err) {
        this.logger.error(__("no contracts found"));
        return;
      }
      contractsList.forEach(contract => {
        if (!contract.deployedAddress) return;

        let address = contract.deployedAddress.toLowerCase();
        if (!this.addressToContract[address]) {
          let funcSignatures = {};
          contract.abiDefinition
            .filter(func => func.type === "function")
            .map(func => {
              const name = func.name +
                '(' +
                (func.inputs ? func.inputs.map(input => input.type).join(',') : '') +
                ')';
              funcSignatures[utils.sha3(name).substring(0, 10)] = {
                name,
                abi: func,
                functionName: func.name
              };
            });

          this.addressToContract[address] = {
            name: contract.className,
            functions: funcSignatures,
            silent: contract.silent
          };
        }
      });
    });
  }

  _listenForLogRequests() {
    if (this.ipc.ipcRole !== 'server') return;
    this.ipc.on('log', (request) => {
      if (request.type !== 'contract-log') {
        return this.logger.info(JSON.stringify(request));
      }

      if (!this.contractsDeployed) return;

      let {address, data, transactionHash, blockNumber, gasUsed, status} = request;
      const contract = this.addressToContract[address];

      if (!contract) {
        this._updateContractList();
        return;
      }

      const {name, silent} = contract;
      if (silent && !this.outputDone) {
        return;
      }

      const func = contract.functions[data.substring(0, 10)];
      const functionName = func.functionName;

      const decodedParameters = utils.decodeParams(func.abi.inputs, data.substring(10));
      let paramString = "";
      if (func.abi.inputs) {
        func.abi.inputs.forEach((input) => {
          let quote = input.type.indexOf("int") === -1 ? '"' : '';
          paramString += quote + decodedParameters[input.name] + quote + ", ";
        });
        paramString = paramString.substring(0, paramString.length - 2);
      }

      gasUsed = utils.hexToNumber(gasUsed);
      blockNumber = utils.hexToNumber(blockNumber);

      const log = Object.assign({}, request, {name, functionName, paramString, gasUsed, blockNumber});
      this.events.emit('contracts:log', log);

      this.logger.info(`Blockchain>`.underline + ` ${name}.${functionName}(${paramString})`.bold + ` | ${transactionHash} | gas:${gasUsed} | blk:${blockNumber} | status:${status}`);
      this.events.emit('blockchain:tx', { name: name, functionName: functionName, paramString: paramString, transactionHash: transactionHash, gasUsed: gasUsed, blockNumber: blockNumber, status: status });
    });
  }

  _registerAPI() {
    const apiRoute = '/embark-api/contracts/logs';
    this.embark.registerAPICall(
      'ws',
      apiRoute,
      (ws, _req) => {
        this.events.on('contracts:log', function(log) {
          ws.send(JSON.stringify(log), () => {});
        });
      }
    );

    this.embark.registerAPICall(
      'get',
      apiRoute,
      async (req, res) => {
        res.send(JSON.stringify(await this._getLogs()));
      }
    );
  }

  async _getLogs() {
    return (await this._readLogs()).reverse();
  }

  async _saveLog(log) {
    const logs = this.logFileQueue;
    if (log) logs.push(log);
    if (!this.logFileDraining ||
        this.logFileReading ||
        this.logFileWriting ||
        !logs.length) {
      return;
    }
    this.logFileWriting = true;
    const delim = ',\n';
    const str = logs.map(l => JSON.stringify(l)).join(delim) + delim;
    logs.length = 0;
    this.logFileDraining = this.logFileWriteStream.write(str, () => {
      this.logFileWriting = false;
      if (logs.length && this.logFileDraining) {
        setImmediate(this._saveLog.bind(this));
      }
    });
    if (!this.logFileDraining) {
      this.logFileWriteStream.once('drain', () => {
        this.logFileDraining = true;
        if (logs.length) {
          setImmediate(this._saveLog.bind(this));
        }
      });
    }
  }

  async _readLogs() {
    while (this.logFileWriting) {
      // eslint-disable-next-line no-await-in-loop
      await utils.timer(1);
    }
    this.logFileReading++;
    try {
      return JSON.parse(`[${(await fs.readFile(this.logFile)).slice(0, -2)}]`);
    } catch (_error) {
      return [];
    } finally {
      this.logFileReading--;
    }
  }
}

module.exports = ConsoleListener;
