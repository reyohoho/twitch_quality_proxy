#!/usr/bin/env node

/**
 * ReYohoho Twitch Proxy - Build Script
 * 
 * Builds extensions for Firefox, Chromium and Userscript
 * from a single codebase.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// ============================================
// BUILD FLAGS
// ============================================
const VAFT_TEST_BUTTON_ENABLED = false; // Set to true to enable VAFT test button

// Ensure dist directories exist
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Read file content
function readFile(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}

// Write file content
function writeFile(filePath, content) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, 'utf-8');
}

// Copy file
function copyFile(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

// Remove module.exports blocks from content
function removeModuleExports(content) {
    // Remove the entire if block for module.exports
    // Pattern: if (typeof module !== 'undefined' && module.exports) { ... }
    return content.replace(/\/\/\s*Export for different environments\s*\n\s*if\s*\(\s*typeof\s+module\s*!==\s*['"]undefined['"]\s*&&\s*module\.exports\s*\)\s*\{[\s\S]*?\n\}/g, '');
}

// Process VAFT test button placeholder
function processVaftTestButton(content, vaftEnabled) {
    const buttonHtml = vaftEnabled 
        ? `<button class="reyohoho-vaft-test-btn" id="reyohoho-vaft-test" style="display: \${vaftEnabled ? 'block' : 'none'}">
        🧪 Тест VAFT (симуляция рекламы)
      </button>`
        : '';
    
    const handlerCode = vaftEnabled
        ? `// VAFT test button handler
    if (vaftTestBtn) {
        vaftTestBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Use CustomEvent to communicate with VAFT in page context
            // This works in CSP-restricted environments (Chromium)
            window.dispatchEvent(new CustomEvent('reyohoho-vaft-simulate', { detail: { depth: 3 } }));
            console.log('[ReYohoho] VAFT simulation triggered');
            
            vaftTestBtn.textContent = '⏳ Симуляция... (30 сек)';
            vaftTestBtn.disabled = true;
            setTimeout(() => {
                vaftTestBtn.textContent = '🧪 Тест VAFT (симуляция рекламы)';
                vaftTestBtn.disabled = false;
            }, 30000);
        });
    }`
        : '';
    
    return content
        .replace('<!-- @build-vaft-test-button -->', buttonHtml)
        .replace('// @build-vaft-test-handler', handlerCode);
}

// Process @build-include directives
function processIncludes(content, baseDir) {
    const includeRegex = /\/\/\s*@build-include\s+(.+)/g;
    let match;
    
    while ((match = includeRegex.exec(content)) !== null) {
        const includePath = match[1].trim();
        const fullPath = path.resolve(baseDir, includePath);
        
        if (fs.existsSync(fullPath)) {
            let includeContent = readFile(fullPath);
            // Recursively process includes
            includeContent = processIncludes(includeContent, path.dirname(fullPath));
            // Remove export statements for bundling
            includeContent = removeModuleExports(includeContent);
            content = content.replace(match[0], includeContent);
        } else {
            console.warn(`Warning: Include file not found: ${fullPath}`);
        }
    }
    
    return content;
}

// Prepare VAFT code for injection (escape for template literal)
function prepareVaftForInjection() {
    let vaftCode = readFile(path.join(SRC_DIR, 'core', 'vaft.js'));
    vaftCode = removeModuleExports(vaftCode);
    
    // Add VAFT_CONFIG and call initVAFT
    const constantsCode = readFile(path.join(SRC_DIR, 'core', 'constants.js'));
    // Extract only VAFT_CONFIG from constants
    const vaftConfigMatch = constantsCode.match(/const VAFT_CONFIG = \{[\s\S]*?\};/);
    const vaftConfig = vaftConfigMatch ? vaftConfigMatch[0] : '';
    
    return `${vaftConfig}\n${vaftCode}\ninitVAFT();`;
}

// Build Firefox extension
function buildFirefox() {
    console.log('Building Firefox extension...');
    
    const firefoxDir = path.join(DIST_DIR, 'firefox');
    ensureDir(firefoxDir);
    
    // Copy manifest
    copyFile(
        path.join(SRC_DIR, 'platform', 'firefox', 'manifest.json'),
        path.join(firefoxDir, 'manifest.json')
    );
    
    // Build background.js
    let backgroundContent = readFile(path.join(SRC_DIR, 'platform', 'firefox', 'background.js'));
    backgroundContent = processIncludes(backgroundContent, path.join(SRC_DIR, 'platform', 'firefox'));
    
    // Inline constants
    const constantsContent = readFile(path.join(SRC_DIR, 'core', 'constants.js'));
    backgroundContent = backgroundContent.replace('// @build-include ../core/constants.js', constantsContent);
    
    // Inline proxy checker
    const proxyCheckerContent = readFile(path.join(SRC_DIR, 'core', 'proxy-checker.js'));
    backgroundContent = backgroundContent.replace('// @build-include ../core/proxy-checker.js', proxyCheckerContent);
    
    writeFile(path.join(firefoxDir, 'background.js'), backgroundContent);
    
    // Build content.js
    let contentContent = readFile(path.join(SRC_DIR, 'content.js'));
    
    // Inline all core modules
    const constants = readFile(path.join(SRC_DIR, 'core', 'constants.js'));
    let uiPanel = readFile(path.join(SRC_DIR, 'core', 'ui-panel.js'));
    uiPanel = processVaftTestButton(uiPanel, VAFT_TEST_BUTTON_ENABLED);
    
    contentContent = contentContent
        .replace('// @build-include core/constants.js', constants)
        .replace('// @build-include core/ui-panel.js', uiPanel);
    
    // For Firefox: use inline script injection
    const vaftForInjection = prepareVaftForInjection();
    const escapedVaft = vaftForInjection
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
    
    const firefoxVaftInjection = `script.textContent = \`${escapedVaft}\`;`;
    contentContent = contentContent.replace('// @build-vaft-injection', firefoxVaftInjection);
    
    // Remove module exports
    contentContent = removeModuleExports(contentContent);
    
    writeFile(path.join(firefoxDir, 'content.js'), contentContent);
    
    // Copy styles
    copyFile(
        path.join(SRC_DIR, 'core', 'styles.css'),
        path.join(firefoxDir, 'styles.css')
    );
    
    console.log('Firefox extension built successfully!');
    return firefoxDir;
}

// Build Chromium extension
function buildChromium() {
    console.log('Building Chromium extension...');
    
    const chromiumDir = path.join(DIST_DIR, 'chromium');
    ensureDir(chromiumDir);
    
    // Copy manifest
    copyFile(
        path.join(SRC_DIR, 'platform', 'chromium', 'manifest.json'),
        path.join(chromiumDir, 'manifest.json')
    );
    
    // Build background.js
    let backgroundContent = readFile(path.join(SRC_DIR, 'platform', 'chromium', 'background.js'));
    
    // Inline constants
    const constantsContent = readFile(path.join(SRC_DIR, 'core', 'constants.js'));
    backgroundContent = backgroundContent.replace('// @build-include ../core/constants.js', constantsContent);
    
    // Inline proxy checker
    const proxyCheckerContent = readFile(path.join(SRC_DIR, 'core', 'proxy-checker.js'));
    backgroundContent = backgroundContent.replace('// @build-include ../core/proxy-checker.js', proxyCheckerContent);
    
    // Remove module exports
    backgroundContent = removeModuleExports(backgroundContent);
    
    writeFile(path.join(chromiumDir, 'background.js'), backgroundContent);
    
    // Build VAFT as separate file for Chromium (CSP requirement)
    const vaftForFile = prepareVaftForInjection();
    writeFile(path.join(chromiumDir, 'vaft.js'), `(function(){\n${vaftForFile}\n})();`);
    
    // Build content.js
    let contentContent = readFile(path.join(SRC_DIR, 'content.js'));
    
    // Inline all core modules
    const constants = readFile(path.join(SRC_DIR, 'core', 'constants.js'));
    let uiPanel = readFile(path.join(SRC_DIR, 'core', 'ui-panel.js'));
    uiPanel = processVaftTestButton(uiPanel, VAFT_TEST_BUTTON_ENABLED);
    
    contentContent = contentContent
        .replace('// @build-include core/constants.js', constants)
        .replace('// @build-include core/ui-panel.js', uiPanel);

    // For Chromium: use external script due to CSP
    contentContent = contentContent.replace(
        '// @build-vaft-injection',
        `script.src = chrome.runtime.getURL('vaft.js');`
    );
    
    // Remove module exports
    contentContent = removeModuleExports(contentContent);
    
    writeFile(path.join(chromiumDir, 'content.js'), contentContent);
    
    // Copy styles
    copyFile(
        path.join(SRC_DIR, 'core', 'styles.css'),
        path.join(chromiumDir, 'styles.css')
    );
    
    console.log('Chromium extension built successfully!');
    return chromiumDir;
}

// Build Userscript
function buildUserscript() {
    console.log('Building Userscript...');
    
    const userscriptDir = path.join(DIST_DIR, 'userscript');
    ensureDir(userscriptDir);
    
    // Read header (contains proxy interceptor and IIFE start)
    let userscript = readFile(path.join(SRC_DIR, 'platform', 'userscript', 'header.js'));
    userscript += '\n\n';
    
    // Add styles injection (using DOM, not GM_addStyle since we use @grant none)
    const styles = readFile(path.join(SRC_DIR, 'core', 'styles.css'));
    const escapedStyles = styles.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
    userscript += `// Inject styles when DOM is ready
(function injectStyles() {
    const style = document.createElement('style');
    style.textContent = \`${escapedStyles}\`;
    if (document.head) {
        document.head.appendChild(style);
    } else {
        document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
    }
})();

`;
    
    // Add constants
    userscript += readFile(path.join(SRC_DIR, 'core', 'constants.js'));
    userscript += '\n\n';
    
    // Add UI Panel
    let uiPanelCode = readFile(path.join(SRC_DIR, 'core', 'ui-panel.js'));
    uiPanelCode = processVaftTestButton(uiPanelCode, VAFT_TEST_BUTTON_ENABLED);
    userscript += uiPanelCode;
    userscript += '\n\n';
    
    // Add main script (modified for userscript)
    let mainScript = readFile(path.join(SRC_DIR, 'content.js'));
    
    // Remove build includes
    mainScript = mainScript
        .replace('// @build-include core/constants.js', '')
        .replace('// @build-include core/ui-panel.js', '');
    
    // For Userscript: use inline script injection (same as Firefox)
    const vaftForInjection = prepareVaftForInjection();
    const escapedVaft = vaftForInjection
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
    
    const userscriptVaftInjection = `script.textContent = \`${escapedVaft}\`;`;
    mainScript = mainScript.replace('// @build-vaft-injection', userscriptVaftInjection);
    
    userscript += mainScript;
    
    // Remove module exports
    userscript = removeModuleExports(userscript);
    
    writeFile(path.join(userscriptDir, 'reyohoho-twitch.user.js'), userscript);
    
    console.log('Userscript built successfully!');
    return userscriptDir;
}

// Create ZIP archive
function createZip(sourceDir, outputPath) {
    console.log(`Creating ZIP: ${outputPath}`);
    
    try {
        // Remove existing zip
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        
        // Create zip using system zip command - archive files directly without parent folder
        const absoluteOutputPath = path.resolve(outputPath);
        
        execSync(`cd "${sourceDir}" && zip -r "${absoluteOutputPath}" .`, { stdio: 'inherit' });
        
        console.log(`ZIP created: ${outputPath}`);
    } catch (error) {
        console.error(`Error creating ZIP: ${error.message}`);
        console.log('Skipping ZIP creation (zip command not available)');
    }
}

// Main build function
function build(target) {
    console.log('='.repeat(50));
    console.log('ReYohoho Twitch Proxy - Build Script');
    console.log('='.repeat(50));
    
    const targets = target ? [target] : ['firefox', 'chromium', 'userscript'];
    
    for (const t of targets) {
        switch (t) {
            case 'firefox':
                const firefoxDir = buildFirefox();
                createZip(firefoxDir, path.join(DIST_DIR, 'firefox.zip'));
                break;
            case 'chromium':
                const chromiumDir = buildChromium();
                createZip(chromiumDir, path.join(DIST_DIR, 'chromium.zip'));
                break;
            case 'userscript':
                buildUserscript();
                break;
            default:
                console.error(`Unknown target: ${t}`);
        }
    }
    
    console.log('='.repeat(50));
    console.log('Build complete!');
    console.log('='.repeat(50));
}

// Parse command line arguments
const args = process.argv.slice(2);
const target = args[0];

build(target);
