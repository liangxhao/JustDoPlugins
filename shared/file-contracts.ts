// Optional host/plugin file-opening convention. Native views still own all App operations.
export const FILE_OPEN_METHOD_PREFIX = 'mcp-app-files.open.';
export const FILE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export const FILE_RESOURCE_PREFIX = 'app-file://';
export const FILE_DEEP_LINK_PREFIX = '/workspace-file/';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const STAGE_FILE_TOOL = 'stage_workspace_file';
export const OPEN_FILE_TOOL = 'open_workspace_file';
export const FILE_RESOURCE_METHOD_PREFIX = 'mcp-app-files.resource.';
export const AUTHORIZE_FILE_SAVE_TOOL = 'authorize_workspace_file_save';
