import chalk from 'chalk';
import ms from 'ms';
import table from '../../util/output/table';
import title from 'title';
import { parseArguments } from '../../util/get-args';
import { handleError } from '../../util/error';
import elapsed from '../../util/output/elapsed';
import toHost from '../../util/to-host';
import parseMeta from '../../util/parse-meta';
import parsePolicy from '../../util/parse-policy';
import { isValidName } from '../../util/is-valid-name';
import getCommandFlags from '../../util/get-command-flags';
import { getCommandName } from '../../util/pkg-name';
import Client from '../../util/client';
import { ensureLink } from '../../util/link/ensure-link';
import getScope from '../../util/get-scope';
import { ProjectNotFound } from '../../util/errors-ts';
import { isErrnoException } from '@vercel/error-utils';
import { help } from '../help';
import { listCommand } from './command';
import parseTarget from '../../util/parse-target';
import { getFlagsSpecification } from '../../util/get-flags-specification';
import getDeployment from '../../util/get-deployment';
import getProjectByNameOrId from '../../util/projects/get-project-by-id-or-name';
import type { Deployment } from '@vercel-internals/types';

function toDate(timestamp: number): string {
  const date = new Date(timestamp);
  const options: Intl.DateTimeFormatOptions = {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  };

  // The locale 'en-US' ensures the format is MM/DD/YY
  return date.toLocaleDateString('en-US', options);
}

export default async function list(client: Client) {
  const { print, log, warn, error, note, debug, spinner } = client.output;

  let parsedArgs = null;

  const flagsSpecification = getFlagsSpecification(listCommand.options);

  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (error) {
    handleError(error);
    return 1;
  }

  if (parsedArgs.flags['--help']) {
    print(help(listCommand, { columns: client.stderr.columns }));
    return 2;
  }

  if ('--confirm' in parsedArgs.flags) {
    warn('`--confirm` is deprecated, please use `--yes` instead');
    parsedArgs.flags['--yes'] = parsedArgs.flags['--confirm'];
  }

  if (parsedArgs.args.length > 2) {
    error(`${getCommandName('ls [app]')} accepts at most one argument`);
    return 1;
  }

  const autoConfirm = !!parsedArgs.flags['--yes'];
  const meta = parseMeta(parsedArgs.flags['--meta']);
  const policy = parsePolicy(parsedArgs.flags['--policy']);

  const target = parseTarget({
    output: client.output,
    flagName: 'environment',
    flags: parsedArgs.flags,
  });

  let project;
  let pagination;
  let contextName;
  let app: string | undefined = parsedArgs.args[1];
  let deployments: Deployment[] = [];

  if (app) {
    if (!isValidName(app)) {
      error(`The provided argument "${app}" is not a valid project name`);
      return 1;
    }
    if (app.includes('.')) {
      // `app` looks like a hostname / URL, so fetch the deployment
      // from the API and retrieve the project ID from the deployment
      try {
        ({ contextName } = await getScope(client));
      } catch (err: unknown) {
        if (
          isErrnoException(err) &&
          (err.code === 'NOT_AUTHORIZED' || err.code === 'TEAM_DELETED')
        ) {
          error(err.message);
          return 1;
        }
      }
      if (!contextName) {
        error('No context name found');
        return 1;
      }

      const host = toHost(app);
      const deployment = await getDeployment(client, contextName, host);
      if (!deployment.projectId) {
        error(`Could not find a deployment for "${host}"`);
        return 1;
      }
      app = deployment.projectId;
      note(
        `We suggest using ${getCommandName(
          'inspect <deployment>'
        )} for retrieving details about a single deployment`
      );
      deployments.push(deployment);
    } else {
      project = await getProjectByNameOrId(client, app);
      if (project instanceof ProjectNotFound) {
        error(`The provided argument "${app}" is not a valid project name`);
        return 1;
      }
    }
  } else {
    const link = await ensureLink('list', client, client.cwd, {
      autoConfirm,
    });
    if (typeof link === 'number') return link;
    project = link.project;
    client.config.currentTeam = link.org.id;
  }

  if (!contextName) {
    try {
      ({ contextName } = await getScope(client));
    } catch (err: unknown) {
      if (
        isErrnoException(err) &&
        (err.code === 'NOT_AUTHORIZED' || err.code === 'TEAM_DELETED')
      ) {
        error(err.message);
        return 1;
      }
    }
  }

  const nextTimestamp = parsedArgs.flags['--next'];

  if (Number.isNaN(nextTimestamp)) {
    error('Please provide a number for flag `--next`');
    return 1;
  }

  if (project) {
    spinner(`Fetching deployments in ${chalk.bold(contextName)}`);
    const start = Date.now();

    debug('Fetching deployments');

    const query = new URLSearchParams({ limit: '20', projectId: project.id });
    for (const [k, v] of Object.entries(meta)) {
      query.set(`meta-${k}`, v);
    }
    for (const [k, v] of Object.entries(policy)) {
      query.set(`policy-${k}`, v);
    }

    if (nextTimestamp) {
      query.set('until', String(nextTimestamp));
    }

    if (target) {
      query.set('target', target);
    }
    for await (const chunk of client.fetchPaginated<{
      deployments: Deployment[];
    }>(`/v6/deployments?${query}`)) {
      deployments.push(...chunk.deployments);
      pagination = chunk.pagination;
      if (deployments.length >= 20) {
        break;
      }
    }

    // we don't output the table headers if we have no deployments
    if (!deployments.length) {
      log(`No deployments found.`);
      return 0;
    }

    log(
      `${
        target === 'production' ? `Production deployments` : `Deployments`
      } for ${chalk.bold(project.name)} under ${chalk.bold(
        contextName
      )} ${elapsed(Date.now() - start)}`
    );
  }

  // information to help the user find other deployments or instances
  log(
    `To list deployments for a project, run ${getCommandName('ls [project]')}.`
  );

  print('\n');

  const headers = ['Age', 'Deployment', 'Status', 'Environment'];
  const showPolicy = Object.keys(policy).length > 0;
  // Exclude username & duration if we're showing retention policies so that the table fits more comfortably
  if (!showPolicy) headers.push(...['Duration', 'Username']);
  if (showPolicy) headers.push('Proposed Expiration');
  const urls: string[] = [];

  client.output.print(
    `${table(
      [
        headers.map(header => chalk.bold(chalk.cyan(header))),
        ...deployments
          .sort(sortByCreatedAt)
          .map(dep => {
            urls.push(`https://${dep.url}`);
            const proposedExp = dep.proposedExpiration
              ? toDate(Math.min(Date.now(), dep.proposedExpiration))
              : 'No expiration';
            const createdAt = ms(
              Date.now() - (dep?.undeletedAt ?? dep.createdAt)
            );
            return [
              chalk.gray(createdAt),
              `https://${dep.url}`,
              stateString(dep.readyState || ''),
              dep.target === 'production' ? 'Production' : 'Preview',
              ...(!showPolicy ? [chalk.gray(getDeploymentDuration(dep))] : []),
              ...(!showPolicy ? [chalk.gray(dep.creator?.username)] : []),
              ...(showPolicy ? [chalk.gray(proposedExp)] : []),
            ];
          })
          .filter(app =>
            // if an app wasn't supplied to filter by,
            // we only want to render one deployment per app
            app === null ? filterUniqueApps() : () => true
          ),
      ],
      { hsep: 5 }
    ).replace(/^/gm, '  ')}\n\n`
  );

  if (!client.stdout.isTTY) {
    client.stdout.write(urls.join('\n'));
    client.stdout.write('\n');
  }

  if (pagination?.next) {
    const flags = getCommandFlags(parsedArgs.flags, ['--next']);
    log(
      `To display the next page, run ${getCommandName(
        `ls${app ? ' ' + app : ''}${flags} --next ${pagination.next}`
      )}`
    );
  }
}

export function getDeploymentDuration(dep: Deployment): string {
  if (!dep || !dep.ready || !dep.buildingAt) {
    return '?';
  }
  const duration = ms(dep.ready - dep.buildingAt);
  if (duration === '0ms') {
    return '--';
  }
  return duration;
}

// renders the state string
export function stateString(s: string) {
  const CIRCLE = '● ';
  // make `s` title case
  const sTitle = title(s);
  switch (s) {
    case 'INITIALIZING':
    case 'BUILDING':
    case 'DEPLOYING':
    case 'ANALYZING':
      return chalk.yellow(CIRCLE) + sTitle;
    case 'ERROR':
      return chalk.red(CIRCLE) + sTitle;
    case 'READY':
      return chalk.green(CIRCLE) + sTitle;
    case 'QUEUED':
      return chalk.white(CIRCLE) + sTitle;
    case 'CANCELED':
      return chalk.gray(sTitle);
    default:
      return chalk.gray('UNKNOWN');
  }
}

// sorts by most recent deployment
function sortByCreatedAt(a: Deployment, b: Deployment) {
  return b.createdAt - a.createdAt;
}

// filters only one deployment per app, so that
// the user doesn't see so many deployments at once.
// this mode can be bypassed by supplying an app name
function filterUniqueApps() {
  const uniqueApps = new Set();
  return function uniqueAppFilter([appName]: [appName: string]) {
    if (uniqueApps.has(appName)) {
      return false;
    }
    uniqueApps.add(appName);
    return true;
  };
}
