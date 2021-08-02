import { Parser } from '@helpers/sigaa-parser';
import { HTTP, ProgressCallback } from '@session/sigaa-http';
import { Session } from '@session/sigaa-session';
import { LoginStatus } from '../sigaa-types';
import { URL } from 'url';
import { BondFactory, BondType } from '@bonds/sigaa-bond-factory';
import { Page } from '@session/sigaa-page';
import { Account } from './sigaa-account';

/**
 * Responsible for representing the user account.
 * @category Internal
 */
export class SigaaAccountIFFAR implements Account {
  /**
   * @param homepage homepage (page after login) of user.
   */
  constructor(
    homepage: Page,
    private http: HTTP,
    private parser: Parser,
    private session: Session,
    private bondFactory: BondFactory
  ) {
    this.parseHomepage(homepage);
  }

  /**
   * Error message when the new password chosen does not meet the security requirements of SIGAA.
   * It is thrown by the changePassword() method
   */
  readonly errorInvalidCredentials = 'SIGAA: Invalid credentials.';

  /**
   * Error message when the old password is not the current password.
   * It is thrown by the changePassword() method.
   */
  readonly errorInsufficientPasswordComplexity =
    'SIGAA: Insufficent password complexity.';

  /**
   * Student name cache
   */
  private _name?: string;

  /**
   * Student e-mail cache
   */
  private _emails?: string[];

  /**
   * Array of active bonds.
   */
  private activeBonds: BondType[] = [];

  /**
   * Array of inactive bonds.
   */
  private inactiveBonds: BondType[] = [];

  /**
   * It is a promise that stores if the page parser has already completed
   */
  private pagehomeParsePromise?: Promise<void>;

  /**
   * Parse login result page to fill the instance.
   *
   * @param homepage home page to parse.
   */
  private parseHomepage(homepage: Page): void {
    //Since the login page can vary, we should check the type of page.
    if (
      homepage.bodyDecoded.includes(
        'O sistema comportou-se de forma inesperada'
      )
    ) {
      throw new Error(
        'SIGAA: Invalid homepage, the system behaved unexpectedly.'
      );
    }
    if (homepage.url.href.includes('sigaa/portais/discente/discente.jsf')) {
      //If it is home page student of desktop version.
      this.pagehomeParsePromise = this.parseStudentHomePage(homepage);
    } else if (
      homepage.url.href.includes('/sigaa/vinculos.jsf') ||
      homepage.url.href.includes('/sigaa/escolhaVinculo.do')
    ) {
      //If it is bond page.
      this.pagehomeParsePromise = this.parseBondPage(homepage);
    } else {
      throw new Error('SIGAA: Unknown homepage format.');
    }
  }

  /**
   * Parse bond page.
   * @param page page to parse.
   */
  private async parseBondPage(page: Page) {
    const rows = page.$('table.formulario tbody tr').toArray();
    for (const row of rows) {
      const cells = page.$(row).find('td').toArray();
      if (cells.length === 0) continue;

      const bondType = this.parser.removeTagsHtml(
        page.$(row).find('#tdTipo').html()
      );
      const status = this.parser.removeTagsHtml(page.$(cells[3]).html());
      let bond;
      switch (bondType) {
        case 'Discente': {
          const registration = this.parser.removeTagsHtml(
            page.$(cells[2]).html()
          );

          const url = page.$(row).find('a[href]').attr('href');
          if (!url)
            throw new Error('SIGAA: Bond switch url could not be found.');
          const bondSwitchUrl = new URL(url, page.url);

          const program = this.parser
            .removeTagsHtml(page.$(cells[4]).html())
            .replace(/^Curso: /g, '');
          bond = this.bondFactory.createStudentBond(
            registration,
            program,
            bondSwitchUrl
          );
          break;
        }
        case 'Docente': {
          bond = this.bondFactory.createTeacherBond();
          break;
        }
      }
      if (bond)
        if (status === 'Sim') {
          this.activeBonds.push(bond);
        } else if (status === 'Não') {
          this.inactiveBonds.push(bond);
        } else {
          console.log('SIGAA: WARNING invalid status: ' + status);
        }
    }
  }

  /**
   * @inheritdoc
   */
  async getActiveBonds(): Promise<BondType[]> {
    await this.pagehomeParsePromise;
    return this.activeBonds;
  }

  /**
   * @inheritdoc
   */
  async getInactiveBonds(): Promise<BondType[]> {
    await this.pagehomeParsePromise;
    return this.inactiveBonds;
  }

  /**
   * Parse desktop version of student home page page.
   */
  private async parseStudentHomePage(homepage: Page) {
    const rows = homepage.$('#agenda-docente table').eq(0).find('tr').toArray();
    let registration;
    let program;
    let status;

    const buttonSwitchBond = this.parser.removeTagsHtml(
      homepage.$('#info-usuario p i small a').html()
    );
    if (buttonSwitchBond === 'Alterar vínculo') {
      const bondPage = await this.http.get('/sigaa/vinculos.jsf');
      return this.parseBondPage(bondPage);
    }

    for (const row of rows) {
      const cells = homepage.$(row).find('td');
      if (cells.length !== 2) {
        throw new Error('SIGAA: Invalid student details page.');
      }
      const rowName = this.parser.removeTagsHtml(cells.eq(0).html());
      switch (rowName) {
        case 'Matrícula:':
          registration = this.parser.removeTagsHtml(cells.eq(1).html());
          break;
        case 'Curso:':
          program = this.parser
            .removeTagsHtml(cells.eq(1).html())
            .replace(/ - (M|T|N)$/g, ''); // Remove schedule letter
          break;
        case 'Status:':
          status = this.parser.removeTagsHtml(cells.eq(1).html());
      }
      if (registration && program && status) break;
    }

    if (!registration)
      throw new Error('SIGAA: Student bond without registration code.');

    if (!program) throw new Error('SIGAA: Student bond program not found.');

    if (!status) throw new Error('SIGAA: Student bond status not found.');
    if (status === 'ATIVO')
      this.activeBonds.push(
        this.bondFactory.createStudentBond(registration, program, null)
      );
    else
      this.inactiveBonds.push(
        this.bondFactory.createStudentBond(registration, program, null)
      );
  }

  /**
   * @inheritdoc
   */
  logoff(): Promise<void> {
    return this.http
      .get('/sigaa/logar.do?dispatch=logOff')
      .then((page) => {
        return this.http.followAllRedirect(page);
      })
      .then((page) => {
        if (page.statusCode !== 200) {
          throw new Error('SIGAA: Invalid status code in logoff page.');
        }
        this.session.loginStatus = LoginStatus.Unauthenticated;
        this.http.closeSession();
      });
  }

  /**
   * Get profile picture URL.
   * @retuns Picture url or null if the user has no photo.
   */
  async getProfilePictureURL(): Promise<URL | null> {
    const page = await this.http.get('/sigaa/portais/discente/discente.jsf');

    const pictureElement = page.$('div[class="foto"] img');
    if (pictureElement.length === 0) return null;
    const pictureSrc = pictureElement.attr('src');
    if (!pictureSrc || pictureSrc.includes('/sigaa/img/no_picture.png'))
      return null;
    return new URL(pictureSrc, page.url);
  }

  /**
   * Download profile url and save in basepath.
   * @param destpath It can be a folder or a file name, if it is a directory then it will be saved inside the folder, if it is a file name it will be saved exactly in this place, but if the folder does not exist it will throw an error.
   * @param callback To know the progress of the download, each downloaded part will be called informing how much has already been downloaded.
   * @retuns Full path of the downloaded file, useful if the destpath is a directory, or null if the user has no photo.
   */
  async downloadProfilePicture(
    destpath: string,
    callback?: ProgressCallback
  ): Promise<string | null> {
    const pictureURL = await this.getProfilePictureURL();
    if (!pictureURL) return null;
    return this.http.downloadFileByGet(pictureURL.href, destpath, callback);
  }

  /**
   * @inheritdoc
   */
  async getName(): Promise<string> {
    if (this._name) return this._name;
    const page = await this.http.get('/sigaa/portais/discente/discente.jsf');
    if (page.statusCode === 200) {
      const username = this.parser.removeTagsHtml(
        page.$('p.usuario > span').html()
      );
      this._name = username;
      return username;
    } else {
      throw new Error('SIGAA: Unexpected status code at student profile page.');
    }
  }

  /**
   * @inheritdoc
   */
  async getEmails(): Promise<string[]> {
    if (this._emails) return this._emails;
    const page = await this.http.get('/sigaa/portais/discente/discente.jsf');
    if (page.statusCode === 200) {
      const buttons = page
        .$('#perfil-docente .pessoal-docente')
        .find('a[onclick]')
        .toArray();

      for (const button of buttons) {
        const buttonName = this.parser.removeTagsHtml(page.$(button).html());
        if (buttonName === 'Meus Dados Pessoais') {
          const buttonOnClick = page.$(button).attr('onclick');
          if (buttonOnClick) {
            const form = page.parseJSFCLJS(buttonOnClick);
            const myPersonalDataPage = await this.http.post(
              form.action.href,
              form.postValues
            );
            const rows = myPersonalDataPage
              .$('td[colspan="3"] table tbody tr')
              .toArray();
            this._emails = [];
            for (const row of rows) {
              const email = this.parser.removeTagsHtml(page.$(row).html());
              this._emails.push(email);
            }
          }

          break;
        }
      }
      if (this._emails) return this._emails;
      return [];
    } else {
      throw new Error('SIGAA: Unexpected status code at student profile page.');
    }
  }

  /**
   * Change the password of account.
   * @param oldPassword current password.
   * @param newPassword new password.
   * @throws {errorInvalidCredentials} If current password is not correct.
   * @throws {errorInsufficientPasswordComplexity} If the new password does not have the complexity requirement.
   */
  async changePassword(
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    const formPage = await this.http.get('/sigaa/alterar_dados.jsf');
    if (formPage.statusCode !== 302)
      throw new Error('SIGAA: Unexpected status code at change password form.');

    const prePage = await this.http.followAllRedirect(formPage);
    if (
      prePage.statusCode !== 200 ||
      !prePage.url.href.includes('usuario/alterar_dados.jsf')
    )
      throw new Error('SIGAA: Invalid pre page at change password.');

    const preFormElement = prePage.$('form[name="form"]');

    const preAction = preFormElement.attr('action');
    if (!preAction)
      throw new Error(
        'SIGAA: Form without action at change password pre page.'
      );

    const preActionUrl = new URL(preAction, prePage.url.href);

    const prePostValues: Record<string, string> = {};

    const preInputs = preFormElement
      .find("input[name]:not([type='submit'])")
      .toArray();
    for (const input of preInputs) {
      const name = prePage.$(input).attr('name');
      if (name) {
        prePostValues[name] = prePage.$(input).val();
      }
    }
    prePostValues['form:alterarSenha'] = 'form:alterarSenha';
    const page = await this.http.post(preActionUrl.href, prePostValues);
    const formElement = page.$('form[name="form"]');

    const action = formElement.attr('action');
    if (!action)
      throw new Error('SIGAA: Form without action at change password page.');
    const formAction = new URL(action, page.url.href);

    const postValues: Record<string, string> = {};
    const inputs = formElement
      .find("input[name]:not([type='submit'])")
      .toArray();
    for (const input of inputs) {
      const name = page.$(input).attr('name');
      if (name) {
        postValues[name] = prePage.$(input).val();
      }
    }

    postValues['form:senhaAtual'] = oldPassword;
    postValues['form:novaSenha'] = newPassword;
    postValues['form:repetnNovaSenha'] = newPassword;
    postValues['form:alterarDados'] = 'Alterar Dados';

    const resultPage = await this.http.post(formAction.href, postValues);

    if (resultPage.statusCode === 200) {
      const errorMsg = this.parser.removeTagsHtml(
        resultPage.$('.erros li').html()
      );
      if (errorMsg.includes('A senha digitada é muito simples.')) {
        throw new Error(this.errorInsufficientPasswordComplexity);
      }
      if (errorMsg.includes('Senha Atual digitada não confere')) {
        throw new Error(this.errorInvalidCredentials);
      }
    }

    if (resultPage.statusCode !== 302) {
      throw new Error(
        'SIGAA: The change password page status code is different than expected.'
      );
    }
  }
}
