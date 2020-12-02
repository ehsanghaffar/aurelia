/* eslint-disable no-undef */
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { join, resolve } from 'path';
import * as Mocha from 'mocha';
import * as kill from 'tree-kill';
import { Data, FrameworkMetadata } from './shared';

async function main({ framework, iterations }: { framework: Data<FrameworkMetadata>; iterations: number }) {
  let app: ChildProcessWithoutNullStreams = null!;
  let failures: number = 0;
  try {
    const fxName = framework.name;
    const appPath = resolve(process.cwd(), framework.localPath);
    await buildApp(fxName, appPath);

    const port = framework.port;
    app = await startApp(fxName, appPath, port);

    // Run bench
    // Inject globals
    (globalThis as any).$$framework = framework.name;
    (globalThis as any).$$port = port;
    (globalThis as any).$$iterations = iterations;
    const measurements = (globalThis as any).$$measurements = [];
    const mocha = new Mocha({
      ui: 'bdd',
      color: true,
      reporter: 'spec',
      timeout: 1200000,
    });
    mocha.addFile(join(__dirname, 'bench.spec.js'));
    await new Promise<void>((res, rej) => {
      mocha.run(function ($failures) {
        failures = $failures;
        if ($failures === 0) {
          res();
        } else {
          rej(new Error(`mocha failed for '${fxName}'.`));
        }
      });
    });
    process.send!(measurements);
  } catch (e) {
    console.error(`run for the framework '${framework.name}' failed with`, e);
  } finally {
    if (app !== null) {
      kill(app.pid);
    }
    process.exit(failures);
  }
}

async function buildApp(fxName: string, appPath: string) {
  return new Promise<void>((res, rej) => {
    const build = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'build'],
      { cwd: appPath }
    );
    build.stdout.on('data', function (d) { console.log(d.toString()); });
    build.stderr.on('data', function (d) {
      rej(new Error(`The app for the framework '${fxName}' cannot be built. Error: ${d.toString()}`));
    });
    build.on('exit', res);
  });
}

async function startApp(fxName: string, appPath: string, port: string) {
  return new Promise<ChildProcessWithoutNullStreams>((res, rej) => {
    const app = spawn(
      'node',
      [
        '-r',
        'esm',
        './node_modules/@aurelia/http-server/dist/esnext/cli.js',
        '--root',
        join(appPath, 'dist'),
        '--port',
        port,
        '--responseCacheControl',
        'no-store'
      ]
    );
    app.stdout.on('data', function (d) {
      const message: string = d.toString();
      console.log(message);
      if (new RegExp(`listening.+:${port}`).test(message)) {
        res(app);
      }
    });
    app.stderr.on('data', function (d) {
      rej(new Error(`The app for the framework '${fxName}' cannot be started. Error: ${d.toString()}`));
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-misused-promises
process.on('message', main);
