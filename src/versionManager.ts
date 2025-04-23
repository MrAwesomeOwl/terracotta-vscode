import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as fs from "fs"
import * as zlib from "zlib"
import { finished } from 'stream/promises';
import { Readable } from 'stream';
import { chmod } from 'fs/promises';
import { compareVersions } from './util/compareVersions';

export class VersionManager {
    constructor(
        private context: vscode.ExtensionContext,
        private onLoadedCallback: () => void
    ) {
        this.versionsUri = Uri.joinPath(this.context.globalStorageUri,"versions")

        this.fetchDownloadableVersions()
        this.findInstalledVersions()
    }
    private versionsUri: Uri

    downloadableVersions: Set<string> = new Set();
    installedVersions: Set<string> = new Set();
    latestDownloadableRelease: string = "0.0.0"
    
    downloadInProgress = false
    versionsFolderIsUsable: boolean = false

    private downloadInfo: {
        /** key: version */
        [key: string]: {
            [key:string]: string
        }
    } = {}

    private _loadStepsComplete = 0
    
    async fetchDownloadableVersions() {
        let releases: Response
        try {
            releases = await fetch("https://api.github.com/repos/mrawesomeowl/terracotta/releases");
        } catch (e) {
            let desc: string | undefined = undefined
            if (`${e}` == "InvalidArgumentError: Invalid URL protocol: the URL must start with `http:` or `https:`.") {
                desc = "If you have a system proxy enabled, try turning that off and restarting VSCode. For whatever reason, VSCode has a tendency to throw a fit when it sees a system proxy."
            }
            vscode.window.showErrorMessage(`Error while fetching Terracotta releases: ${e}`,{modal: true, detail: desc})
            return
        }
        if (releases.ok) {
            for (const release of await releases.json() as any) {
                if (!release.tag_name.startsWith("v")) {continue}
                let version = release.tag_name.substring(1)

                this.downloadableVersions.add(version)
                this.downloadInfo[version] = {}
                if (compareVersions(version,"0.0.0") == 1 && version.split("-").length == 1) {
                    this.latestDownloadableRelease = version
                }

                for (const asset of Object.values(release.assets) as any[]) {
                    let platform = [...(asset.name as string).matchAll(/((?:darwin|linux|win32)-(?:x64|arm64))\.gz$/g)][0]?.[1]
                    if (platform) {
                        this.downloadInfo[version][platform] = asset.browser_download_url
                    }
                }
            }
        } else {
            vscode.window.showErrorMessage("Failed to fetch Terracotta releases:",releases.statusText)
        }
        this._loadStepsComplete += 1;
        if (this._loadStepsComplete >= 2) {
            this.onLoadedCallback()
        }
    }

    async findInstalledVersions() {
        // make sure versions folder is accessible and exists
        try {
            let result = await vscode.workspace.fs.stat(this.versionsUri)
            if ((result.type & vscode.FileType.Directory) == 0) {
                vscode.window.showErrorMessage(`Terracotta installation path (${this.versionsUri.fsPath}) is not a folder.`)
                return
            }
        } catch (e) {
            if (e instanceof vscode.FileSystemError && e.code == "FileNotFound") {
                await vscode.workspace.fs.createDirectory(this.versionsUri)
            } else {
                vscode.window.showErrorMessage(`Terracotta installation path (${this.versionsUri.fsPath}) is inaccessible: ${e}`)
                return
            }
        }

        this.versionsFolderIsUsable = true

        // actually do what the name of the function suggests it will do
        for (const versionFolder of await vscode.workspace.fs.readDirectory(this.versionsUri)) {
            if ((versionFolder[1] & vscode.FileType.Directory) > 0) { 
                this.installedVersions.add(versionFolder[0])
            }
        }
        
        this._loadStepsComplete += 1;
        if (this._loadStepsComplete >= 2) {
            this.onLoadedCallback()
        }
    }

    /** will throw an error if it fails */
    async downloadVersion(version: string) {
        if (this.downloadInProgress) {
            throw new Error(`Cannot download version ${version} at this time because a download task is already in progress.`)
        }
        if (!(version in this.downloadInfo)) {
            throw new Error(`Cannot download unknown version ${version}.`)
        }
        if (version in this.installedVersions) {
            throw new Error(`Cannot download version ${version} because it is already installed.`)
        }
        let platform = `${process.platform}-${process.arch}`
        if (!(platform in this.downloadInfo[version])) {
            throw new Error(`Terracotta v${version} does not support your operating system.`)
        }
        
        let versionDirUri = Uri.joinPath(this.versionsUri,version)
        let destinationPath = this.getExecutablePath(version)

        this.downloadInProgress = true
        let result = await fetch(this.downloadInfo[version][platform])
        if (!result.ok) {
            this.downloadInProgress = false
            throw new Error(`Failed to download Terracotta v${version}. Server responded with: ${result.status} ${result.statusText}`)
        }
        if (result.body == null) {
            this.downloadInProgress = false
            throw new Error("Server responded with no data.")
        }

        try {
            await vscode.workspace.fs.createDirectory(versionDirUri)
            const writeStream = fs.createWriteStream(destinationPath,{flags: "wx", encoding: 'binary'})
            const gunzip = zlib.createGunzip();
            await finished(Readable.fromWeb(result.body).pipe(gunzip).pipe(writeStream))
            await chmod(destinationPath,0o755)
        } catch (e) {
            // if something went wong, get rid of the folder so the extension doesn't think its installed
            await vscode.workspace.fs.delete(versionDirUri,{recursive: true, useTrash: true})
            this.downloadInProgress = false
            throw new Error(`Failed to install Terracotta v${version}: ${e}`)
        }

        this.installedVersions.add(version)
        this.downloadInProgress = false
    }

    getExecutablePath(version: string) {
        let platform = `${process.platform}-${process.arch}`
        return Uri.joinPath(this.versionsUri,version,`terracotta-${platform}${platform.startsWith('win32') ? '.exe' : ''}`).fsPath
    }
}