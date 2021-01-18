import logger from '../util/logger';
import * as WebRTC from '../util/webrtc';
import { isDefined } from '../util/helpers';
import { DeviceType } from './constants';
import { IVertoCallOptions } from './interfaces';

const getUserMedia = async (
  constraints: MediaStreamConstraints
): Promise<MediaStream | null> => {
  logger.info('RTCService.getUserMedia', constraints);
  const { audio, video } = constraints;
  if (!audio && !video) {
    return null;
  }
  try {
    return await WebRTC.getUserMedia(constraints);
  } catch (error) {
    logger.error('getUserMedia error: ', error);
    throw error;
  }
};

const _constraintsByKind = (
  kind: string = null
): { audio: boolean; video: boolean } => {
  return {
    audio: !kind || kind === DeviceType.AudioIn,
    video: !kind || kind === DeviceType.Video,
  };
};

/**
 * Retrieve device list using the browser APIs
 * If 'deviceId' or 'label' are missing it means we are on Safari (macOS or iOS)
 * so we must request permissions to the user and then refresh the device list.
 *
 * Browser Compatibility Note: Firefox has yet to fully implement
 * audio output devices. As of v63, this feature is behind the
 * user preference `media.setsinkid.enabled`.
 * See: https://bugzilla.mozilla.org/show_bug.cgi?id=1152401#c98
 *
 * @ignore
 */
const getDevices = async (
  kind: MediaDeviceKind | undefined = null,
  fullList: boolean = false
): Promise<MediaDeviceInfo[]> => {
  let devices = await WebRTC.enumerateDevices().catch((error) => []);
  if (kind) {
    devices = devices.filter((d: MediaDeviceInfo) => d.kind === kind);
  }
  const valid: boolean =
    devices.length &&
    devices.every((d: MediaDeviceInfo) => d.deviceId && d.label);
  if (!valid) {
    const stream = await WebRTC.getUserMedia(_constraintsByKind(kind));
    WebRTC.stopStream(stream);
    return getDevices(kind);
  }
  if (fullList === true) {
    return devices;
  }
  const found = [];
  devices = devices.filter(({ kind, groupId }: MediaDeviceInfo) => {
    if (!groupId) {
      return true;
    }
    const key = `${kind}-${groupId}`;
    if (!found.includes(key)) {
      found.push(key);
      return true;
    }
    return false;
  });

  return devices;
};

const resolutionList = [
  [320, 240],
  [640, 360],
  [640, 480],
  [1280, 720],
  [1920, 1080],
];
const scanResolutions = async (deviceId: string) => {
  const supported = [];
  const stream = await getUserMedia({
    video: { deviceId: { exact: deviceId } },
  });
  const videoTrack = stream.getVideoTracks()[0];
  for (let i = 0; i < resolutionList.length; i++) {
    const [width, height] = resolutionList[i];
    const success = await videoTrack
      .applyConstraints({ width: { exact: width }, height: { exact: height } })
      .then(() => true)
      .catch(() => false);
    if (success) {
      supported.push({ resolution: `${width}x${height}`, width, height });
    }
  }
  WebRTC.stopStream(stream);

  return supported;
};

const getMediaConstraints = async (
  options: IVertoCallOptions
): Promise<MediaStreamConstraints> => {
  let { audio = true, micId } = options;
  const { micLabel = '' } = options;
  if (micId) {
    micId = await assureDeviceId(micId, micLabel, DeviceType.AudioIn).catch(
      (error) => null
    );
    if (micId) {
      if (typeof audio === 'boolean') {
        audio = {};
      }
      audio.deviceId = { exact: micId };
    }
  }

  let { video = false, camId } = options;
  const { camLabel = '' } = options;
  if (camId) {
    camId = await assureDeviceId(camId, camLabel, DeviceType.Video).catch(
      (error) => null
    );
    if (camId) {
      if (typeof video === 'boolean') {
        video = {};
      }
      video.deviceId = { exact: camId };
    }
  }

  return { audio, video };
};

const assureDeviceId = async (
  id: string,
  label: string,
  kind: MediaDeviceInfo['kind']
): Promise<string> => {
  const devices = await getDevices(kind, true);
  for (let i = 0; i < devices.length; i++) {
    const { deviceId, label: deviceLabel } = devices[i];
    if (id === deviceId || label === deviceLabel) {
      return deviceId;
    }
  }

  return null;
};

const removeUnsupportedConstraints = (
  constraints: MediaTrackConstraints
): void => {
  const supported = WebRTC.getSupportedConstraints();
  Object.keys(constraints).map((key) => {
    if (
      !supported.hasOwnProperty(key) ||
      constraints[key] === null ||
      constraints[key] === undefined
    ) {
      delete constraints[key];
    }
  });
};

const checkDeviceIdConstraints = async (
  id: string,
  label: string,
  kind: MediaDeviceInfo['kind'],
  constraints: MediaTrackConstraints
) => {
  const { deviceId } = constraints;
  if (!isDefined(deviceId) && (id || label)) {
    const deviceId = await assureDeviceId(id, label, kind).catch(
      (error) => null
    );
    if (deviceId) {
      constraints.deviceId = { exact: deviceId };
    }
  }
  return constraints;
};

/**
 * Add stereo support hacking the SDP
 * @return the SDP modified
 * @ignore
 */
const sdpStereoHack = (sdp: string) => {
  const endOfLine = '\r\n';
  const sdpLines = sdp.split(endOfLine);

  const opusIndex = sdpLines.findIndex(
    (s) => /^a=rtpmap/.test(s) && /opus\/48000/.test(s)
  );
  if (opusIndex < 0) {
    return sdp;
  }

  const getCodecPayloadType = (line: string) => {
    const pattern = new RegExp('a=rtpmap:(\\d+) \\w+\\/\\d+');
    const result = line.match(pattern);
    return result && result.length == 2 ? result[1] : null;
  };
  const opusPayload = getCodecPayloadType(sdpLines[opusIndex]);

  const pattern = new RegExp(`a=fmtp:${opusPayload}`);
  const fmtpLineIndex = sdpLines.findIndex((s) => pattern.test(s));

  if (fmtpLineIndex >= 0) {
    if (!/stereo=1;/.test(sdpLines[fmtpLineIndex])) {
      // Append stereo=1 to fmtp line if not already present
      sdpLines[fmtpLineIndex] += '; stereo=1; sprop-stereo=1';
    }
  } else {
    // create an fmtp line
    sdpLines[
      opusIndex
    ] += `${endOfLine}a=fmtp:${opusPayload} stereo=1; sprop-stereo=1`;
  }

  return sdpLines.join(endOfLine);
};

const _isAudioLine = (line: string) => /^m=audio/.test(line);
const _isVideoLine = (line: string) => /^m=video/.test(line);

const sdpMediaOrderHack = (answer: string, localOffer: string): string => {
  const endOfLine = '\r\n';
  const offerLines = localOffer.split(endOfLine);
  const offerAudioIndex = offerLines.findIndex(_isAudioLine);
  const offerVideoIndex = offerLines.findIndex(_isVideoLine);
  if (offerAudioIndex < offerVideoIndex) {
    return answer;
  }

  const answerLines = answer.split(endOfLine);
  const answerAudioIndex = answerLines.findIndex(_isAudioLine);
  const answerVideoIndex = answerLines.findIndex(_isVideoLine);
  const audioLines = answerLines.slice(answerAudioIndex, answerVideoIndex);
  const videoLines = answerLines.slice(
    answerVideoIndex,
    answerLines.length - 1
  );
  const beginLines = answerLines.slice(0, answerAudioIndex);
  return [...beginLines, ...videoLines, ...audioLines, ''].join(endOfLine);
};

const checkSubscribeResponse = (response: any, channel: string): boolean => {
  if (!response) {
    return false;
  }
  const { subscribed, alreadySubscribed } = destructSubscribeResponse(response);
  return subscribed.includes(channel) || alreadySubscribed.includes(channel);
};

type DestructuredResult = {
  subscribed: string[];
  alreadySubscribed: string[];
  unauthorized: string[];
  unsubscribed: string[];
  notSubscribed: string[];
};

const destructSubscribeResponse = (response: any): DestructuredResult => {
  const tmp = {
    subscribed: [],
    alreadySubscribed: [],
    unauthorized: [],
    unsubscribed: [],
    notSubscribed: [],
  };
  Object.keys(tmp).forEach((k) => {
    tmp[k] = response[`${k}Channels`] || [];
  });
  return tmp;
};

const enableAudioTracks = (stream: MediaStream) => {
  _updateMediaStreamTracks(stream, 'audio', true);
};

const disableAudioTracks = (stream: MediaStream) => {
  _updateMediaStreamTracks(stream, 'audio', false);
};

const toggleAudioTracks = (stream: MediaStream) => {
  _updateMediaStreamTracks(stream, 'audio', null);
};

const enableVideoTracks = (stream: MediaStream) => {
  _updateMediaStreamTracks(stream, 'video', true);
};

const disableVideoTracks = (stream: MediaStream) => {
  _updateMediaStreamTracks(stream, 'video', false);
};

const toggleVideoTracks = (stream: MediaStream) => {
  _updateMediaStreamTracks(stream, 'video', null);
};

const _updateMediaStreamTracks = (
  stream: MediaStream,
  kind: string = null,
  enabled: boolean | string = null
) => {
  if (!WebRTC.streamIsValid(stream)) {
    return null;
  }
  let tracks: MediaStreamTrack[] = [];
  switch (kind) {
    case 'audio':
      tracks = stream.getAudioTracks();
      break;
    case 'video':
      tracks = stream.getVideoTracks();
      break;
    default:
      tracks = stream.getTracks();
      break;
  }
  tracks.forEach((track: MediaStreamTrack) => {
    switch (enabled) {
      case 'on':
      case true:
        track.enabled = true;
        break;
      case 'off':
      case false:
        track.enabled = false;
        break;
      default:
        track.enabled = !track.enabled;
        break;
    }
  });
};

/**
 * Modify the SDP to increase video bitrate
 * @return the SDP modified
 * @ignore
 */
const sdpBitrateHack = (
  sdp: string,
  max: number,
  min: number,
  start: number
) => {
  const endOfLine = '\r\n';
  const lines = sdp.split(endOfLine);
  lines.forEach((line, i) => {
    if (/^a=fmtp:\d*/.test(line)) {
      lines[
        i
      ] += `;x-google-max-bitrate=${max};x-google-min-bitrate=${min};x-google-start-bitrate=${start}`;
    } else if (/^a=mid:(1|video)/.test(line)) {
      lines[i] += `\r\nb=AS:${max}`;
    }
  });
  return lines.join(endOfLine);
};

function getBrowserInfo() {
  if (!window || !window.navigator || !window.navigator.userAgent) {
    throw new Error(
      'You should use @telnyx/webrtc in a web browser such as Chrome|Safari|Firefox'
    );
  }

  if (
    navigator.userAgent.match(/chrom(e|ium)/gim) &&
    !navigator.userAgent.match(/OPR\/[0-9]{2}/gi) &&
    !navigator.userAgent.match(/edg/gim)
  ) {
    const info = navigator.userAgent
      .match(/chrom(e|ium)\/[0-9]+\./gim)[0]
      .split('/');
    const name = info[0];
    const version = parseInt(info[1], 10);

    return {
      name,
      version,
      supportAudio: true,
      supportVideo: true,
    };
  }

  if (
    navigator.userAgent.match(/firefox/gim) &&
    !navigator.userAgent.match(/OPR\/[0-9]{2}/gi) &&
    !navigator.userAgent.match(/edg/gim)
  ) {
    const info = navigator.userAgent
      .match(/firefox\/[0-9]+\./gim)[0]
      .split('/');

    const name = info[0];
    const version = parseInt(info[1], 10);

    return {
      name,
      version,
      supportAudio: true,
      supportVideo: false,
    };
  }

  if (
    navigator.userAgent.match(/safari/gim) &&
    !navigator.userAgent.match(/OPR\/[0-9]{2}/gi) &&
    !navigator.userAgent.match(/edg/gim)
  ) {
    const name = navigator.userAgent.match(/safari/gim)[0];
    const fullVersion = navigator.userAgent
      .match(/version\/[0-9]+\./gim)[0]
      .split('/');
    const version = parseInt(fullVersion[1], 10);
    return {
      name,
      version,
      supportAudio: true,
      supportVideo: true,
    };
  }

  if (
    navigator.userAgent.match(/edg/gim) &&
    !navigator.userAgent.match(/OPR\/[0-9]{2}/gi)
  ) {
    const info = navigator.userAgent.match(/edg\/[0-9]+\./gim)[0].split('/');
    const name = info[0];
    const version = parseInt(info[1], 10);

    return {
      name,
      version,
      supportAudio: true,
      supportVideo: true,
    };
  }
  throw new Error(
    'This browser does not support @telnyx/webrtc. \nPlease, use Chrome|Firefox|Safari.'
  );
}

function getWebRTCInfo() {
  try {
    const browserInfo = navigator.userAgent;
    const { name, version, supportAudio, supportVideo } = getBrowserInfo();
    const PC = window.RTCPeerConnection;
    const sessionDescription = window.RTCSessionDescription;
    const iceCandidate = window.RTCIceCandidate;
    const mediaDevices = navigator.mediaDevices;
    const getUserMediaMethod =
      navigator.getUserMedia ||
      navigator.webkitGetUserMedia ||
      navigator.msGetUserMedia ||
      navigator.mozGetUserMedia;

    return {
      browserInfo,
      browserName: name,
      browserVersion: version,
      supportWebRTC:
        !!PC &&
        !!sessionDescription &&
        !!iceCandidate &&
        !!mediaDevices &&
        !!getUserMediaMethod,
      supportWebRTCAudio: supportAudio,
      supportWebRTCVideo: supportVideo,
      supportRTCPeerConnection: !!PC,
      supportSessionDescription: !!sessionDescription,
      supportIceCandidate: !!iceCandidate,
      supportMediaDevices: !!mediaDevices,
      supportGetUserMedia: !!getUserMedia,
    };
  } catch (error) {
    console.error(error.message);
  }
}

export {
  getUserMedia,
  getDevices,
  scanResolutions,
  getMediaConstraints,
  assureDeviceId,
  removeUnsupportedConstraints,
  checkDeviceIdConstraints,
  sdpStereoHack,
  sdpMediaOrderHack,
  sdpBitrateHack,
  checkSubscribeResponse,
  destructSubscribeResponse,
  enableAudioTracks,
  disableAudioTracks,
  toggleAudioTracks,
  enableVideoTracks,
  disableVideoTracks,
  toggleVideoTracks,
  getBrowserInfo,
  getWebRTCInfo,
};
