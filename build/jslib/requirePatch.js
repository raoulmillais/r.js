/**
 * @license RequireJS Copyright (c) 2010-2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
/*
 * This file patches require.js to communicate with the build system.
 */

//Using sloppy since this uses eval for some code like plugins,
//which may not be strict mode compliant. So if use strict is used
//below they will have strict rules applied and may cause an error.
/*jslint sloppy: true, nomen: true, plusplus: true, regexp: true */
/*global require, define: true */

//NOT asking for require as a dependency since the goal is to modify the
//global require below
define([ 'env!env/file', 'pragma', 'parse', 'lang', 'logger', 'commonJs'],
function (file,           pragma,   parse,   lang,   logger,   commonJs) {

    var allowRun = true;

    //This method should be called when the patches to require should take hold.
    return function () {
        if (!allowRun) {
            return;
        }
        allowRun = false;

        var layer,
            pluginBuilderRegExp = /(["']?)pluginBuilder(["']?)\s*[=\:]\s*["']([^'"\s]+)["']/,
            oldNewContext = require.s.newContext,
            oldDef,

            //create local undefined values for module and exports,
            //so that when files are evaled in this function they do not
            //see the node values used for r.js
            exports,
            module;

        //Stored cached file contents for reuse in other layers.
        require._cachedFileContents = {};

        /**
         * Makes sure the URL is something that can be supported by the
         * optimization tool.
         * @param {String} url
         * @returns {Boolean}
         */
        require._isSupportedBuildUrl = function (url) {
            //Ignore URLs with protocols, hosts or question marks, means either network
            //access is needed to fetch it or it is too dynamic. Note that
            //on Windows, full paths are used for some urls, which include
            //the drive, like c:/something, so need to test for something other
            //than just a colon.
            if (url.indexOf("://") === -1 && url.indexOf("?") === -1 &&
                   url.indexOf('empty:') !== 0 && url.indexOf('//') !== 0) {
                return true;
            } else {
                if (!layer.ignoredUrls[url]) {
                    logger.info('Cannot optimize network URL, skipping: ' + url);
                    layer.ignoredUrls[url] = true;
                }
                return false;
            }
        };

        function normalizeUrlWithBase(context, moduleName, url) {
            //Adjust the URL if it was not transformed to use baseUrl.
            if (require.jsExtRegExp.test(moduleName)) {
                url = (context.config.dir || context.config.dirBaseUrl) + url;
            }
            return url;
        }

        //Overrides the new context call to add existing tracking features.
        require.s.newContext = function (name) {
            var context = oldNewContext(name),
                oldEnable = context.enable,
                moduleProto = context.Module.prototype,
                oldInit = moduleProto.init,
                oldCallPlugin = moduleProto.callPlugin;

            //Only do this for the context used for building.
            if (name === '_') {
                context.needFullExec = {};
                context.fullExec = {};
                context.plugins = {};

                //Override the shim exports function generator to just
                //spit out strings that can be used in the stringified
                //build output.
                context.makeShimExports = function (exports) {
                    var result;
                    if (typeof exports === 'string') {
                        result = function () {
                            return '(function (global) {\n' +
                            '    return function () {\n' +
                            '        return global.' + exports + ';\n' +
                            '    }\n' +
                            '}(this))';
                        };
                    } else {
                        result = function () {
                            return '(function (global) {\n' +
                            '    return function () {\n' +
                            '        var func = ' + exports.toString() + ';\n' +
                            '        return func.apply(global, arguments);\n' +
                            '    }\n' +
                            '}(this))';
                        };
                    }

                    //Mark the result has being tranformed by the build already.
                    result.__buildReady = true;
                    return result;
                };

                context.enable = function (depMap, parent) {
                    var id = depMap.id,
                        parentId = parent && parent.map.id,
                        needFullExec = context.needFullExec,
                        fullExec = context.fullExec,
                        mod = context.registry[id];

                    if (mod && !mod.defined) {
                        if (parentId && needFullExec[parentId]) {
                            needFullExec[id] = true;
                        }
                    } else if ((needFullExec[id] && !fullExec[id]) ||
                               (parentId && needFullExec[parentId] && !fullExec[id])) {
                        context.undef(id);
                    }

                    return oldEnable.apply(context, arguments);
                };

                //Override load so that the file paths can be collected.
                context.load = function (moduleName, url) {
                    /*jslint evil: true */
                    var contents, pluginBuilderMatch, builderName;

                    //Do not mark the url as fetched if it is
                    //not an empty: URL, used by the optimizer.
                    //In that case we need to be sure to call
                    //load() for each module that is mapped to
                    //empty: so that dependencies are satisfied
                    //correctly.
                    if (url.indexOf('empty:') === 0) {
                        delete context.urlFetched[url];
                    }

                    //Only handle urls that can be inlined, so that means avoiding some
                    //URLs like ones that require network access or may be too dynamic,
                    //like JSONP
                    if (require._isSupportedBuildUrl(url)) {
                        //Adjust the URL if it was not transformed to use baseUrl.
                        url = normalizeUrlWithBase(context, moduleName, url);

                        //Save the module name to path  and path to module name mappings.
                        layer.buildPathMap[moduleName] = url;
                        layer.buildFileToModule[url] = moduleName;

                        if (context.plugins.hasOwnProperty(moduleName)) {
                            //plugins need to have their source evaled as-is.
                            context.needFullExec[moduleName] = true;
                        }

                        try {
                            if (require._cachedFileContents.hasOwnProperty(url) &&
                                (!context.needFullExec[moduleName] || context.fullExec[moduleName])) {
                                contents = require._cachedFileContents[url];
                            } else {
                                //Load the file contents, process for conditionals, then
                                //evaluate it.
                                contents = file.readFile(url);

                                if (context.config.cjsTranslate) {
                                    contents = commonJs.convert(url, contents);
                                }

                                //If there is a read filter, run it now.
                                if (context.config.onBuildRead) {
                                    contents = context.config.onBuildRead(moduleName, url, contents);
                                }

                                contents = pragma.process(url, contents, context.config, 'OnExecute');

                                //Find out if the file contains a require() definition. Need to know
                                //this so we can inject plugins right after it, but before they are needed,
                                //and to make sure this file is first, so that define calls work.
                                //This situation mainly occurs when the build is done on top of the output
                                //of another build, where the first build may include require somewhere in it.
                                try {
                                    if (!layer.existingRequireUrl && parse.definesRequire(url, contents)) {
                                        layer.existingRequireUrl = url;
                                    }
                                } catch (e1) {
                                    throw new Error('Parse error using UglifyJS ' +
                                                    'for file: ' + url + '\n' + e1);
                                }

                                if (context.plugins.hasOwnProperty(moduleName)) {
                                    //This is a loader plugin, check to see if it has a build extension,
                                    //otherwise the plugin will act as the plugin builder too.
                                    pluginBuilderMatch = pluginBuilderRegExp.exec(contents);
                                    if (pluginBuilderMatch) {
                                        //Load the plugin builder for the plugin contents.
                                        builderName = context.makeModuleMap(pluginBuilderMatch[3],
                                                                            context.makeModuleMap(moduleName),
                                                                            null,
                                                                            true).id;
                                        contents = file.readFile(context.nameToUrl(builderName));
                                    }
                                }

                                //Parse out the require and define calls.
                                //Do this even for plugins in case they have their own
                                //dependencies that may be separate to how the pluginBuilder works.
                                try {
                                    if (!context.needFullExec[moduleName]) {
                                        contents = parse(moduleName, url, contents, {
                                            insertNeedsDefine: true,
                                            has: context.config.has,
                                            findNestedDependencies: context.config.findNestedDependencies
                                        });
                                    }
                                } catch (e2) {
                                    throw new Error('Parse error using UglifyJS ' +
                                                    'for file: ' + url + '\n' + e2);
                                }

                                require._cachedFileContents[url] = contents;
                            }

                            if (contents) {
                                eval(contents);
                            }

                            //Need to close out completion of this module
                            //so that listeners will get notified that it is available.
                            try {
                                context.completeLoad(moduleName);
                            } catch (e) {
                                //Track which module could not complete loading.
                                if (!e.moduleTree) {
                                    e.moduleTree = [];
                                }
                                e.moduleTree.push(moduleName);
                                throw e;
                            }

                        } catch (eOuter) {
                            if (!eOuter.fileName) {
                                eOuter.fileName = url;
                            }
                            throw eOuter;
                        }
                    } else {
                        //With unsupported URLs still need to call completeLoad to
                        //finish loading.
                        context.completeLoad(moduleName);
                    }
                };

                //Marks module has having a name, and optionally executes the
                //callback, but only if it meets certain criteria.
                context.execCb = function (name, cb, args, exports) {
                    if (!layer.needsDefine[name]) {
                        layer.modulesWithNames[name] = true;
                    }
                    if (cb.__requireJsBuild || layer.context.needFullExec[name]) {
                        return cb.apply(exports, args);
                    }
                    return undefined;
                };

                moduleProto.init = function(depMaps) {
                    if (context.needFullExec[this.map.id]) {
                        lang.each(depMaps, lang.bind(this, function (depMap) {
                            if (typeof depMap === 'string') {
                                depMap = context.makeModuleMap(depMap,
                                               (this.map.isDefine ? this.map : this.map.parentMap));
                            }

                            if (!context.fullExec[depMap.id]) {
                                context.undef(depMap.id);
                            }
                        }));
                    }

                    return oldInit.apply(this, arguments);
                };

                moduleProto.callPlugin = function () {
                    var map = this.map,
                        pluginMap = context.makeModuleMap(map.prefix),
                        pluginId = pluginMap.id,
                        pluginMod = context.registry[pluginId];

                    context.plugins[pluginId] = true;
                    context.needFullExec[pluginId] = true;

                    //If the module is not waiting to finish being defined,
                    //undef it and start over, to get full execution.
                    if (!context.fullExec[pluginId] && (!pluginMod || pluginMod.defined)) {
                        context.undef(pluginMap.id);
                    }

                    return oldCallPlugin.apply(this, arguments);
                };
            }

            return context;
        };

        //Clear up the existing context so that the newContext modifications
        //above will be active.
        delete require.s.contexts._;

        /** Reset state for each build layer pass. */
        require._buildReset = function () {
            var oldContext = require.s.contexts._;

            //Clear up the existing context.
            delete require.s.contexts._;

            //Set up new context, so the layer object can hold onto it.
            require({});

            layer = require._layer = {
                buildPathMap: {},
                buildFileToModule: {},
                buildFilePaths: [],
                pathAdded: {},
                modulesWithNames: {},
                needsDefine: {},
                existingRequireUrl: "",
                ignoredUrls: {},
                context: require.s.contexts._
            };

            //Return the previous context in case it is needed, like for
            //the basic config object.
            return oldContext;
        };

        require._buildReset();

        //Override define() to catch modules that just define an object, so that
        //a dummy define call is not put in the build file for them. They do
        //not end up getting defined via context.execCb, so we need to catch them
        //at the define call.
        oldDef = define;

        //This function signature does not have to be exact, just match what we
        //are looking for.
        define = function (name) {
            if (typeof name === "string" && !layer.needsDefine[name]) {
                layer.modulesWithNames[name] = true;
            }
            return oldDef.apply(require, arguments);
        };

        define.amd = oldDef.amd;

        //Add some utilities for plugins
        require._readFile = file.readFile;
        require._fileExists = function (path) {
            return file.exists(path);
        };

        //Called when execManager runs for a dependency. Used to figure out
        //what order of execution.
        require.onResourceLoad = function (context, map) {
            var id = map.id,
                url;

            //If build needed a full execution, indicate it
            //has been done now. But only do it if the context is tracking
            //that. Only valid for the context used in a build, not for
            //other contexts being run, like for useLib, plain requirejs
            //use in node/rhino.
            if (context.needFullExec && context.needFullExec[id]) {
                context.fullExec[id] = true;
            }

            //A plugin.
            if (map.prefix) {
                if (!layer.pathAdded[id]) {
                    layer.buildFilePaths.push(id);
                    //For plugins the real path is not knowable, use the name
                    //for both module to file and file to module mappings.
                    layer.buildPathMap[id] = id;
                    layer.buildFileToModule[id] = id;
                    layer.modulesWithNames[id] = true;
                    layer.pathAdded[id] = true;
                }
            } else if (map.url && require._isSupportedBuildUrl(map.url)) {
                //If the url has not been added to the layer yet, and it
                //is from an actual file that was loaded, add it now.
                url = normalizeUrlWithBase(context, id, map.url);
                if (!layer.pathAdded[url] && layer.buildPathMap[id]) {
                    //Remember the list of dependencies for this layer.
                    layer.buildFilePaths.push(url);
                    layer.pathAdded[url] = true;
                }
            }
        };

        //Called by output of the parse() function, when a file does not
        //explicitly call define, probably just require, but the parse()
        //function normalizes on define() for dependency mapping and file
        //ordering works correctly.
        require.needsDefine = function (moduleName) {
            layer.needsDefine[moduleName] = true;
        };
    };
});
