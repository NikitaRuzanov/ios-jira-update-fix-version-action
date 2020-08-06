const assert = require("assert");
const { inspect } = require("util");

const { command } = require("execa");
const core = require("@actions/core");
const { request } = require("@octokit/request");
const JiraClient = require("jira-connector");

import {context, GitHub} from '@actions/github'

main();

async function main() {
  try {
    const inputs = {
      ticketRegexp: core.getInput("ticketRegexp"),
      targetBranch: core.getInput("targetBranch"),
      sourceBranch: core.getInput("sourceBranch"),
      jiraAccount: core.getInput("jiraAccount"),
      jiraToken: core.getInput("jiraToken"),
      jiraHost: core.getInput("jiraHost"),
      projectName: core.getInput("projectName"),
      versionPrefix: core.getInput("versionPrefix"),
      jiraProjectIds: core.getInput("jiraProjectIds").split(",")
    };

    core.debug(`Inputs: ${inspect(inputs)}`);

    const token = core.getInput('github-token', {required: true})
    const client = new GitHub(token, { })

    // checking the branch
    const brachRegexp = new RegExp(`(release|hotfix)\/${inputs.versionPrefix}.\\d{1,2}.\\d{1,3}`)
    const brachVerification = inputs.sourceBranch.match(/release/gmi)
    if (brachVerification == null) {
      const body = `Wrong brach format. Please fix it. Expected format is ${brachRegexp}`
      await client.issues.createComment({...context.issue, body: body})
      throw "Wrong branch format"
    }

    await runShellCommand(`git fetch origin ${inputs.targetBranch}`)
    await runShellCommand(`git fetch origin ${inputs.sourceBranch}`)

    const commits = await runShellCommand(`git log --pretty=oneline --no-merges origin/${inputs.targetBranch}..${inputs.sourceBranch}`);

    const regexp = new RegExp(inputs.ticketRegexp, "gmi")
    core.info(regexp)
    
    const matches = commits.match(regexp)

    core.info("Commits: " + JSON.stringify(matches));

    var version = await runShellCommand(`sed -n '/MARKETING_VERSION/{s/MARKETING_VERSION = //;s/;//;s/^[[:space:]]*//;p;q;}' ./${inputs.projectName}.xcodeproj/project.pbxproj`)
    version = `${inputs.versionPrefix}.${version}`
    core.info("Version number is " + version)


    var jira = new JiraClient({
      host: inputs.jiraHost,
      basic_auth: {
        email: inputs.jiraAccount,
        api_token: inputs.jiraToken
      },
      strictSSL: true
    });


    for (var i = inputs.jiraProjectIds.length - 1; i >= 0; i--) {
      const project = inputs.jiraProjectIds[i]
      core.info(`Creating ${version} for project -> ${project}` )
      await jira.version.createVersion({ projectId : project, name: version }).catch(function(error) {
        core.info(error)
      });

    }

    var errors = []
    const matchesSet = new Set(matches)
    const trimedArray =  Array.from(matchesSet)
    for (var i = trimedArray.length - 1; i >= 0; i--) {
      const ticket = trimedArray[i]
      core.info(`Updating ticket -> ${ticket}` )
      await jira.issue.editIssue({
        issueKey: `${ticket}`,
        issue: {
          update: {
            fixVersions: [
              {"add" : { name : `${version}` }}
            ]
          }
        }
      }).catch(function(error) {
        core.info(error)
        // clear headers
        var printableError = JSON.parse(error)
        printableError.headers = null
        printableError.issue = printableError.request.uri.path
        printableError.request = null
        errors.push(JSON.stringify(printableError))
      })
    }  

    const urls = inputs.jiraProjectIds.map(id => `Relese notes for project ${id} -> https:\/\/${inputs.jiraHost}\/projects\/${id}?selectedItem=com.atlassian.jira.jira-projects-plugin%3Arelease-page`)
    var body = `Tickets has been updated 🎉 \n please review it: \n ${urls.join("\n\n")}`
    if (errors.length > 0) {
      body = body + `\n\n🆘 There are errors while updating: \n\n ${errors.join("\n\n")}`
    }
    await client.issues.createComment({...context.issue, body: body})

  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

async function runShellCommand(commandString) {
  core.debug(`$ ${commandString}`);
  try {
    const { stdout, stderr } = await command(commandString, { shell: true });
    const output = [stdout, stderr].filter(Boolean).join("\n");
    core.debug(output);
    return output;
  } catch (error) {
    core.debug(inspect(error));
    throw error;
  }
}


