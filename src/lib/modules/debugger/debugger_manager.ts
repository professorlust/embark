const RemixDebug = require("remix-debug-debugtest");
const CmdLine = RemixDebug.CmdLine;
const async = require("async");

export default class DebuggerManager {
  private nodeUrl: string;
  private outputJson: any;
  private inputJson: any;
  private isDebugging: boolean;

  constructor(nodeUrl: string) {
    this.nodeUrl = nodeUrl;
    this.outputJson = {};
    this.inputJson = {};
    this.isDebugging = false;
  }

  public setInputJson(inputJson: any) {
    this.inputJson = inputJson;
  }

  public setOutputJson(outputJson: any) {
    this.outputJson = outputJson;
  }

  public createDebuggerSession(txHash: string, filename: string, cb: any) {
    return this.debug(txHash, filename, cb);
  }

  private debug(txHash: string, filename: string, cb: any) {
    const cmdLine = new CmdLine();
    cmdLine.connect("http", this.nodeUrl);
    cmdLine.loadCompilationData(this.inputJson, this.outputJson);

    cmdLine.initDebugger(() => {
      this.isDebugging = true;

      cmdLine.startDebug(txHash, filename, () => {
        if (cb) {
          cmdLine.triggerSourceUpdate();
          cb();
        }
      });
    });
    return cmdLine;
  }

  public getLastLine(txHash: string, filename: string, outputCb: any) {
    const self = this;
    let cmdLine = new CmdLine();

    async.waterfall([
      function initDebugger(next: any) {
        cmdLine = new CmdLine();
        cmdLine.connect("http", self.nodeUrl);
        cmdLine.loadCompilationData(self.inputJson, self.outputJson);
        cmdLine.initDebugger(() => {
          // self.isDebugging = true
          next();
        });
      },
      function startDebug(next: any) {
        const debuggerData: any = {};
        cmdLine.events.on("locals", (data: any) => {
          debuggerData.locals = self.simplifyDebuggerVars(data);
        });

        cmdLine.events.on("globals", (data: any) => {
          debuggerData.contract = self.simplifyDebuggerVars(data);
        });

        cmdLine.startDebug(txHash, filename, () => {
          cmdLine.events.on("source", () => {
            const lines: string[] = cmdLine.getSource();
            // TODO: this is a bit of a hack
            const line: string = lines.filter((x: string) => x.indexOf("=>") === 0)[0];
            outputCb(lines, line, debuggerData);
          });

          const totalSize = cmdLine.getTraceLength();
          cmdLine.jumpTo(totalSize - 1);
          cmdLine.unload();

          next();
        });
      },
    ], () => {
    });
  }

  // TODO: this is duplicated in debugger/index.js
  private simplifyDebuggerVars(data: any) {
    const newData: any = {};

    for (const key of Object.keys(data)) {
      const field = data[key];
      newData[`${key} (${field.type})`] = field.value;
    }

    return newData;
  }

}
