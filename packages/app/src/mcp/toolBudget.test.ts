import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { selectToolsForRun, isShadowedByBuiltIn, serverIsRelevant, tokens } from './toolBudget';

const tool = (name: string, description = ''): OpenAI.ChatCompletionTool =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } });

const builtIn = ['fs_list_directory', 'fs_move_file', 'fs_read_file', 'fs_search_files', 'web_search', 'browser_click', 'email_send'].map(n => tool(n));
const filesystemSrv = { id: 'fs1', name: 'server-filesystem', tools: ['read_file', 'read_text_file', 'write_file', 'list_directory', 'move_file', 'directory_tree', 'get_file_info', 'list_allowed_directories'].map(n => tool(n)) };
const everythingSrv = { id: 'ev1', name: 'server-everything', tools: [tool('echo', 'Echoes back the input'), tool('add', 'Adds two numbers'), tool('printEnv', 'Prints all environment variables'), tool('longRunningOperation', 'Demonstrates a long running operation')] };
const githubSrv = { id: 'gh1', name: 'github', tools: [tool('list_issues', 'List issues in a GitHub repository'), tool('create_pull_request', 'Open a pull request')] };

describe('shadow rule', () => {
  const names = new Set(builtIn.map(t => t.function.name));
  it('hides MCP tools that duplicate a built-in capability', () => {
    expect(isShadowedByBuiltIn('move_file', names)).toBe(true);
    expect(isShadowedByBuiltIn('list_directory', names)).toBe(true);
    expect(isShadowedByBuiltIn('read_text_file', names)).toBe(true);
    expect(isShadowedByBuiltIn('search_files', names)).toBe(true);
  });
  it('keeps MCP tools that add a capability', () => {
    expect(isShadowedByBuiltIn('directory_tree', names)).toBe(false);
    expect(isShadowedByBuiltIn('list_issues', names)).toBe(false);
    expect(isShadowedByBuiltIn('click', names)).toBe(false);
  });
});

describe('relevance', () => {
  it('matches a server named in the goal', () => {
    expect(serverIsRelevant('open the github issues for artha', githubSrv)).toBe(true);
  });
  it('matches on two tool-vocabulary hits, not one generic verb', () => {
    expect(serverIsRelevant('create a pull request from the issue', githubSrv)).toBe(true);
    expect(serverIsRelevant('add these two numbers and echo the result', everythingSrv)).toBe(true);
    expect(serverIsRelevant('move the spreadsheet into my project folder', everythingSrv)).toBe(false);
  });
  it('tokenises snake and camel case and drops stopwords', () => {
    expect([...tokens('longRunningOperation list_issues the files')]).toEqual(['long', 'running', 'operation', 'issue']);
  });
});

describe('selectToolsForRun', () => {
  const goal = 'Move ~/Downloads/Trinity customer DB B2C (US).xlsx to ~/ATS-interactive-resume-portfolio';
  it('offers built-ins plus only relevant, non-shadowed MCP tools for a file move', () => {
    const r = selectToolsForRun({ builtIn, servers: [filesystemSrv, everythingSrv, githubSrv], goal, recentlyUsed: new Set(), allowlist: [] });
    const names = r.tools.map(t => t.function.name);
    expect(names).toEqual(expect.arrayContaining(builtIn.map(t => t.function.name)));
    expect(names).not.toContain('move_file');          // shadowed twin of fs_move_file
    expect(names).not.toContain('echo');               // demo server, irrelevant
    expect(names).not.toContain('list_issues');        // github, irrelevant
    expect(r.withheld.map(w => w.server).sort()).toEqual(['github', 'server-everything', 'server-filesystem']);
  });
  it('the full set still excludes shadowed twins but includes every other MCP tool', () => {
    const r = selectToolsForRun({ builtIn, servers: [filesystemSrv, everythingSrv], goal, recentlyUsed: new Set(), allowlist: [] });
    const full = r.full.map(t => t.function.name);
    expect(full).toContain('directory_tree');
    expect(full).toContain('echo');
    expect(full).not.toContain('move_file');
  });
  it('keeps a server that already worked in this session', () => {
    const r = selectToolsForRun({ builtIn, servers: [githubSrv], goal, recentlyUsed: new Set(['gh1']), allowlist: [] });
    expect(r.tools.map(t => t.function.name)).toContain('list_issues');
  });
  it('keeps a server an explicit skill allowlists', () => {
    const r = selectToolsForRun({ builtIn, servers: [githubSrv], goal, recentlyUsed: new Set(), allowlist: ['create_pull_request'] });
    expect(r.tools.map(t => t.function.name)).toContain('create_pull_request');
    expect(r.withheld).toEqual([]);
  });
  it('a server whose every tool is shadowed is reported as such, never offered', () => {
    const shadowOnly = { id: 's', name: 'dupfs', tools: [tool('move_file'), tool('read_file')] };
    const r = selectToolsForRun({ builtIn, servers: [shadowOnly], goal: 'move file read file dupfs', recentlyUsed: new Set(), allowlist: [] });
    expect(r.withheld).toEqual([{ server: 'dupfs', reason: 'shadowed' }]);
    expect(r.tools).toHaveLength(builtIn.length);
  });
});
