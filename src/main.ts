// Copyright (c) 2018 Covalent IO

import chalk from "chalk";
import * as child_process from "child_process";
import * as diff from "diff";
import * as editdistance from "fast-levenshtein";
import * as hash from "object-hash";
import * as jp from "jsonpath-plus";
import * as yargs from "yargs";

interface ILabels {
  [key: string]: string | undefined;
}

interface ILabelExpression {
  readonly key: string;
  readonly operator: string;
  readonly values: string[] | undefined;
}

interface ISelectorLabels {
  matchLabels: ILabels;
  matchExpressions: ILabelExpression[];
  isGlobal: boolean;
}

interface ISelector {
  readonly namespace: string;
  readonly name: string;
  readonly selectors: ISelectorLabels[];
}

interface ISelectee {
  readonly namespace: string;
  readonly name: string;
  readonly labels: ILabels;
}

const SELECTEE = {
  ciliumnetworkpolicies: "ciliumendpoints",
  services: "pods"
};

const command = yargs
  .command(
    "$0 <selector>",
    "No resource left unselected 🤯",
    yargs => {
      yargs.positional("selector", {
        choices: ["ciliumnetworkpolicies", "services"]
      });
      return yargs;
    },
    args => {
      handle(args.selector, args.verbose);
    }
  )
  .alias("h", "help")
  .version(false)
  .option("v", {
    alias: "verbose",
    demandOption: false,
    describe: "Verbose output",
    type: "boolean"
  })
  .demandCommand()
  .help();

command["$0"] = "selected";
command.argv;

async function getResource(resource): Promise<string> {
  return new Promise<any>((resolve, reject) => {
    child_process.exec(
      `kubectl get ${resource} --all-namespaces -o=json`,
      { maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        return error ? reject(error) : resolve(stdout);
      }
    );
  });
}

const ITEMS_PATH = "$.items[*]";

const conf: any = {
  ciliumendpoints: {
    labelsPath: "$..identity.labels",
    labelsHandler: (labels: any): ILabels => {
      return labels.length == 1
        ? labels[0].reduce((accum, curr) => {
            const [key, val] = curr.split("=", 2);
            accum[key] = val;
            return accum;
          }, {})
        : {};
    }
  },
  ciliumnetworkpolicies: {
    selectors: {
      "$..endpointSelector": (selectors: any[]): ISelectorLabels[] => {
        return selectors.map((selector): ISelectorLabels => {
          return {
            isGlobal: false,
            matchLabels: selector.matchLabels || {},
            matchExpressions: selector.matchExpressions || []
          };
        });
      }
    },
    globalSelectors: {
      "$..ingress[*].fromEndpoints[*]": (selectors: any): ISelectorLabels[] => {
        return selectors.map((selector): ISelectorLabels => {
          return {
            isGlobal: true,
            matchLabels: selector.matchLabels || {},
            matchExpressions: selector.matchExpressions || []
          };
        });
      }
    }
  },
  pods: {
    labelsPath: "$.metadata.labels",
    labelsHandler: stuff => (stuff.length == 1 ? stuff[0] : {})
  },
  services: {
    selectors: {
      "$.spec.selector": stuff =>
        stuff.length == 1
          ? [{ matchLabels: stuff[0], matchExpressions: [], isGlobal: false }]
          : []
    },
    globalSelectors: {}
  }
};

function getSelectorLabels(
  resource: any,
  resourceName: string,
  selectorType: string
) {
  return Object.keys(conf[resourceName][selectorType])
    .map(selectorPath => {
      return conf[resourceName][selectorType][selectorPath](
        jp({ json: resource, path: selectorPath })
      );
    })
    .reduce((accum, curr) => {
      curr.forEach(selector => {
        accum.set(hash(selector), selector);
      });
      return accum;
    }, new Map<string, any>());
}

async function getSelectors(resourceName): Promise<ISelector[]> {
  const resources = JSON.parse(await getResource(resourceName));
  return jp({ json: resources, path: ITEMS_PATH }).map(
    (resource: any): ISelector => {
      const selectors = getSelectorLabels(resource, resourceName, "selectors");
      const globalSelectors = getSelectorLabels(
        resource,
        resourceName,
        "globalSelectors"
      );
      return {
        namespace: resource.metadata.namespace,
        name: resource.metadata.name,
        selectors: [...selectors.values()].concat([...globalSelectors.values()])
      };
    }
  );
}

async function getSelectees(resource): Promise<ISelectee[]> {
  const selecteeResources = JSON.parse(await getResource(resource));
  return jp({ json: selecteeResources, path: ITEMS_PATH }).map(
    (selectee: any) => {
      const labels = conf[resource].labelsHandler(
        jp({ json: selectee, path: conf[resource].labelsPath })
      );
      return {
        namespace: selectee.metadata.namespace,
        name: selectee.metadata.name,
        labels
      };
    }
  );
}

const CILIUM_NAMESPACE_LABEL_KEY = "k8s:io.kubernetes.pod.namespace";

function labelsToStringSet(labels: ILabels): Set<string> {
  return Object.keys(labels).reduce((accum, curr) => {
    accum.add(`"${curr}":"${labels[curr]}"`);
    return accum;
  }, new Set<string>());
}

async function suggest(
  namespace: string,
  name: string,
  selectorLabels: ISelectorLabels,
  selectees: ISelectee[]
) {
  if (
    selectorLabels.matchLabels[CILIUM_NAMESPACE_LABEL_KEY] &&
    !selectorLabels.isGlobal &&
    namespace !== selectorLabels.matchLabels[CILIUM_NAMESPACE_LABEL_KEY]
  ) {
    console.log(
      chalk`  Invalid namespace {red.bold ${selectorLabels.matchLabels[
        CILIUM_NAMESPACE_LABEL_KEY
      ] as string}}. Namespace must be {green.bold ${namespace}}`
    );
    return;
  }
  const selectorLabelSet = labelsToStringSet(selectorLabels.matchLabels);
  const selecteeLabelSet = selectees
    .filter(
      selectee => selectorLabels.isGlobal || selectee.namespace === namespace
    )
    .reduce((accum, curr) => {
      const labelSet = labelsToStringSet(curr.labels);
      [...labelSet].forEach(label => {
        accum.add(label);
      });
      return accum;
    }, new Set<string>());
  [...selectorLabelSet].forEach(selectorLabel => {
    const distances = [...selecteeLabelSet].map(selecteeLabel => [
      selecteeLabel,
      editdistance.get(selectorLabel, selecteeLabel)
    ]);
    distances.sort((a: any, b: any) => a[1] - b[1]);
    if (distances.length === 0 || distances[0][1] == 0 || distances[0][1] > 7) {
      return;
    }
    process.stdout.write(
      chalk`  {red.bold ${selectorLabel}} not found. Did you mean {green.bold ${distances[0][0] as string}}? `
    );
    const result = diff.diffChars(selectorLabel, distances[0][0] as string);
    result.forEach(part => {
      const color = part.added ? "green" : part.removed ? "red" : "grey";
      const style = part.added ? "bold" : part.removed ? "bold" : "reset";
      process.stdout.write(chalk[style][color](part.value));
    });
    console.log();
  });
}

function evaluateExpression(
  expression: ILabelExpression,
  selectee: ISelectee
): boolean {
  const value = selectee.labels[expression.key];
  if (expression.operator === "Exists") {
    return value !== undefined;
  } else if (expression.operator === "In") {
    return (
      value !== undefined &&
      expression.values !== undefined &&
      expression.values.includes(value)
    );
  } else if (expression.operator === "NotIn") {
    return (
      value !== undefined &&
      expression.values !== undefined &&
      !expression.values.includes(value)
    );
  } else {
    return false;
  }
}

function selects(
  selector: ISelector,
  selectorLabels: ISelectorLabels,
  selectee: ISelectee
): boolean {
  if (!selectorLabels.isGlobal && selector.namespace !== selectee.namespace) {
    return false;
  }
  return (
    selectorLabels.matchExpressions
      .map(expression => {
        return evaluateExpression(expression, selectee);
      })
      .every(result => result) &&
    Object.keys(selectorLabels.matchLabels).every(
      key => selectorLabels.matchLabels[key] === selectee.labels[key]
    )
  );
}

function selectorToOneLineString(
  selector: ISelector,
  labels: ISelectorLabels
): string {
  const val = {
    isGlobal: labels.isGlobal,
    ...(Object.keys(labels.matchLabels).length > 0
      ? { matchLabels: labels.matchLabels }
      : {}),
    ...(labels.matchExpressions.length > 0
      ? { matchExpressions: labels.matchExpressions }
      : {})
  };
  return `${selector.namespace}/${selector.name}:${JSON.stringify(val)}`;
}

function selecteeToOneLineString(selectee: ISelectee): string {
  return `${selectee.namespace}/${selectee.name}:${JSON.stringify(
    selectee.labels
  )}`;
}

async function check(
  selectors: ISelector[],
  selectees: ISelectee[],
  verbose: boolean
): Promise<number> {
  let errorCount = 0;
  selectors.forEach(selector => {
    selector.selectors.forEach(labels => {
      if (
        Object.keys(labels.matchLabels).length === 0 &&
        labels.matchExpressions.length === 0
      ) {
        if (verbose) {
          console.log(
            chalk`{green.bold ✔} ${selectorToOneLineString(
              selector,
              labels
            )} selects everything ${
              labels.isGlobal
                ? "across all the namespaces"
                : "inside " + selector.namespace + " namespace"
            }`
          );
        }
        return;
      }
      const selected = selectees
        .map(selectee => {
          if (selects(selector, labels, selectee)) {
            if (verbose) {
              console.log(
                chalk`{green.bold ✔} ${selectorToOneLineString(
                  selector,
                  labels
                )} selects ${selecteeToOneLineString(selectee)}`
              );
            }
            return true;
          }
          return false;
        })
        .some(selected => selected);
      if (!selected) {
        errorCount++;
        console.log(
          chalk`{red.bold ✘} ${selectorToOneLineString(
            selector,
            labels
          )} does not select anything`
        );
        suggest(selector.namespace, selector.name, labels, selectees);
      }
    });
  });
  return errorCount;
}

async function handle(selectorName: string, verbose: boolean) {
  try {
    const selecteeName = SELECTEE[selectorName];
    const selectors = await getSelectors(selectorName);
    const selectees = await getSelectees(selecteeName);
    if (verbose) {
      selectors.forEach(selector => {
        selector.selectors.forEach(matcher => {
          console.log(
            chalk`{blue.bold ℹ} selector:${selectorName} ${selectorToOneLineString(
              selector,
              matcher
            )}`
          );
        });
      });
      selectees.forEach(selectee => {
        console.log(
          chalk`{blue.bold ℹ} selectee:${selecteeName} ${selecteeToOneLineString(
            selectee
          )}`
        );
      });
    }
    const result = await check(selectors, selectees, verbose);
    if (result > 0 && !verbose) {
      console.log(
        chalk`{blue.bold ℹ} Run with {bold -v} to see the list of ${selectorName}/${selecteeName}`
      );
    }
    process.exit(result);
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
}
